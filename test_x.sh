#!/usr/bin/env bash
# Tests for x.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="$SCRIPT_DIR/x.sh"

PASS=0; FAIL=0; ERRORS=""
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  FAIL: $1"; echo "  FAIL: $1"; }
assert_eq() { [ "$1" = "$2" ] && pass "$3" || fail "$3 (expected '$1', got '$2')"; }
assert_contains() { echo "$1" | grep -q "$2" && pass "$3" || fail "$3 (expected to contain '$2')"; }
assert_json() { echo "$1" | jq -e "$2" >/dev/null 2>&1 && pass "$3" || fail "$3 (jq: $2)"; }

# ── Mock server ──

MOCK_PORT=0
MOCK_PID=""
MOCK_DIR=$(mktemp -d)

start_mock() {
    MOCK_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")

    # Create default mock responses
    cat > "$MOCK_DIR/search-recent.json" <<'EOF'
{"data":[{"id":"111","text":"hello world","author_id":"1","created_at":"2026-01-01T00:00:00Z","public_metrics":{"like_count":5}},{"id":"222","text":"second tweet","author_id":"2","created_at":"2026-01-02T00:00:00Z","public_metrics":{"like_count":3}}],"meta":{"result_count":2}}
EOF
    cat > "$MOCK_DIR/tweet-by-id.json" <<'EOF'
{"data":{"id":"111","text":"hello world","author_id":"1","created_at":"2026-01-01T00:00:00Z","public_metrics":{"like_count":5},"conversation_id":"111","lang":"en"}}
EOF
    cat > "$MOCK_DIR/user-by-username.json" <<'EOF'
{"data":{"id":"12345","name":"Test User","username":"testuser","created_at":"2020-01-01T00:00:00Z","description":"A test user","public_metrics":{"followers_count":100,"following_count":50,"tweet_count":500}}}
EOF
    cat > "$MOCK_DIR/user-tweets.json" <<'EOF'
{"data":[{"id":"333","text":"user tweet 1","author_id":"12345","created_at":"2026-01-03T00:00:00Z"},{"id":"444","text":"user tweet 2","author_id":"12345","created_at":"2026-01-04T00:00:00Z"}],"meta":{"result_count":2}}
EOF
    cat > "$MOCK_DIR/post-tweet.json" <<'EOF'
{"data":{"id":"555","text":"posted tweet"}}
EOF

    python3 -c "
import http.server, os, sys, json, re

PORT = int(sys.argv[1])
DATA_DIR = sys.argv[2]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        qs = self.path.split('?', 1)[1] if '?' in self.path else ''
        with open(os.path.join(DATA_DIR, 'last-query.txt'), 'w') as f:
            f.write(qs)
        with open(os.path.join(DATA_DIR, 'last-path.txt'), 'w') as f:
            f.write(path)

        # Route: /2/tweets/search/recent
        if '/tweets/search/recent' in path:
            self._serve('search-recent.json')
        # Route: /2/users/by/username/<name>
        elif re.match(r'.*/users/by/username/', path):
            self._serve('user-by-username.json')
        # Route: /2/users/<id>/tweets
        elif re.match(r'.*/users/\d+/tweets', path):
            self._serve('user-tweets.json')
        # Route: /2/tweets/<id>
        elif re.match(r'.*/tweets/\d+', path):
            self._serve('tweet-by-id.json')
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{\"errors\":[{\"message\":\"not found\"}]}')

    def do_POST(self):
        path = self.path.split('?')[0]
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length) if length else b''
        body = raw.decode()
        with open(os.path.join(DATA_DIR, 'last-post.json'), 'w') as f:
            f.write(body)
        auth = self.headers.get('Authorization', '')
        with open(os.path.join(DATA_DIR, 'last-auth.txt'), 'w') as f:
            f.write(auth)
        with open(os.path.join(DATA_DIR, 'last-path.txt'), 'w') as f:
            f.write(path)
        # Route: /2/tweets (post or reply)
        if '/2/tweets' in path:
            self._serve('post-tweet.json')
        else:
            self.send_response(404)
            self.end_headers()

    def _serve(self, fname):
        fpath = os.path.join(DATA_DIR, fname)
        if os.path.exists(fpath):
            with open(fpath) as f:
                data = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(data.encode())
        else:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b'{\"errors\":[{\"message\":\"mock: file not found\"}]}')
    def log_message(self, *args):
        pass

server = http.server.HTTPServer(('127.0.0.1', PORT), Handler)
server.serve_forever()
" "$MOCK_PORT" "$MOCK_DIR" &
    MOCK_PID=$!
    sleep 0.3
}

stop_mock() {
    [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true
    rm -rf "$MOCK_DIR"
}

set_mock() {
    echo "$2" > "$MOCK_DIR/$1.json"
}

run() {
    bash "$CLIENT" --bearer-token "test-bearer-123" \
        --consumer-key "test-ck" --consumer-secret "test-cs" \
        --access-token "test-at" --access-token-secret "test-ats" \
        --api-base "http://127.0.0.1:$MOCK_PORT" "$@" 2>/dev/null
}

run_read() {
    bash "$CLIENT" --bearer-token "test-bearer-123" \
        --api-base "http://127.0.0.1:$MOCK_PORT" "$@" 2>/dev/null
}

trap stop_mock EXIT
start_mock

echo "=== x.sh tests ==="
echo ""

# ── search ──

echo "search:"

OUT=$(run_read search "test query")
assert_json "$OUT" '.data | length == 2' "search returns 2 results"
assert_json "$OUT" '.data[0].id == "111"' "search first result has id"
assert_json "$OUT" '.data[0].text == "hello world"' "search first result has text"
assert_json "$OUT" '.meta.result_count == 2' "search returns result count"

# Query string includes the query
QUERY=$(cat "$MOCK_DIR/last-query.txt" 2>/dev/null)
assert_contains "$QUERY" "max_results=" "search passes max_results"

# --count parameter
OUT=$(run_read search "test" --count 5)
QUERY=$(cat "$MOCK_DIR/last-query.txt" 2>/dev/null)
assert_contains "$QUERY" "max_results=5" "search --count passes through"

echo ""

# ── tweet ──

echo "tweet:"

OUT=$(run_read tweet 111)
assert_json "$OUT" '.data.id == "111"' "tweet returns id"
assert_json "$OUT" '.data.text == "hello world"' "tweet returns text"

# Verify path
PATH_HIT=$(cat "$MOCK_DIR/last-path.txt" 2>/dev/null)
assert_contains "$PATH_HIT" "/2/tweets/111" "tweet hits correct endpoint"

echo ""

# ── user ──

echo "user:"

OUT=$(run_read user testuser)
assert_json "$OUT" '.data.username == "testuser"' "user returns username"
assert_json "$OUT" '.data.id == "12345"' "user returns id"

# @ prefix stripped
OUT=$(run_read user @testuser)
PATH_HIT=$(cat "$MOCK_DIR/last-path.txt" 2>/dev/null)
assert_contains "$PATH_HIT" "/username/testuser" "user strips @ prefix"

echo ""

# ── tweets ──

echo "tweets:"

OUT=$(run_read tweets testuser)
assert_json "$OUT" '.data | length == 2' "tweets returns 2 results"
assert_json "$OUT" '.data[0].id == "333"' "tweets first result has id"

# --count parameter
OUT=$(run_read tweets testuser --count 3)
QUERY=$(cat "$MOCK_DIR/last-query.txt" 2>/dev/null)
assert_contains "$QUERY" "max_results=3" "tweets --count passes through"

echo ""

# ── post ──

echo "post:"

OUT=$(run post "Hello from test")
assert_json "$OUT" '.data.id == "555"' "post returns tweet id"

# Verify POST body
POSTED=$(cat "$MOCK_DIR/last-post.json" 2>/dev/null)
assert_json "$POSTED" '.text == "Hello from test"' "post sends correct text"

# Verify OAuth header present
AUTH=$(cat "$MOCK_DIR/last-auth.txt" 2>/dev/null)
assert_contains "$AUTH" "OAuth" "post has OAuth Authorization header"
assert_contains "$AUTH" "oauth_consumer_key" "post has oauth_consumer_key"
assert_contains "$AUTH" "oauth_signature" "post has oauth_signature"

echo ""

# ── reply ──

echo "reply:"

OUT=$(run reply 111 "Great thread!")
assert_json "$OUT" '.data.id == "555"' "reply returns tweet id"

# Verify POST body includes reply field
POSTED=$(cat "$MOCK_DIR/last-post.json" 2>/dev/null)
assert_json "$POSTED" '.text == "Great thread!"' "reply sends correct text"
assert_json "$POSTED" '.reply.in_reply_to_tweet_id == "111"' "reply includes in_reply_to_tweet_id"

# Verify OAuth header
AUTH=$(cat "$MOCK_DIR/last-auth.txt" 2>/dev/null)
assert_contains "$AUTH" "OAuth" "reply has OAuth Authorization header"

echo ""

# ── credential errors ──

echo "errors:"

# Missing bearer token for read
OUT=$(bash "$CLIENT" --api-base "http://127.0.0.1:$MOCK_PORT" search "test" 2>/dev/null) || true
assert_json "$OUT" '.error' "missing creds gives error"
assert_contains "$OUT" "sudo" "error mentions sudo"

# Missing OAuth for write (bearer-only)
OUT=$(bash "$CLIENT" --bearer-token "test-bearer-123" --api-base "http://127.0.0.1:$MOCK_PORT" post "test" 2>/dev/null) || true
assert_json "$OUT" '.error' "missing OAuth for post gives error"
assert_contains "$OUT" "OAuth" "error mentions OAuth"

echo ""

# ── missing args ──

echo "missing args:"

OUT=$(run_read search 2>/dev/null) || true
assert_json "$OUT" '.error' "search missing query gives error"

OUT=$(run_read tweet 2>/dev/null) || true
assert_json "$OUT" '.error' "tweet missing id gives error"

OUT=$(run_read user 2>/dev/null) || true
assert_json "$OUT" '.error' "user missing username gives error"

OUT=$(run post 2>/dev/null) || true
assert_json "$OUT" '.error' "post missing text gives error"

OUT=$(run reply 2>/dev/null) || true
assert_json "$OUT" '.error' "reply missing args gives error"

echo ""

# ── API error passthrough ──

echo "api errors:"

set_mock search-recent '{"errors":[{"message":"Rate limit exceeded"}]}'
OUT=$(run_read search "test" 2>/dev/null) || true
# Mock returns 200 for this test, but the error JSON is passed through
assert_contains "$OUT" "Rate limit" "API error JSON passed through"

# Restore
set_mock search-recent '{"data":[{"id":"111","text":"hello world"}],"meta":{"result_count":1}}'

echo ""

# ── help ──

echo "help:"

OUT=$(run help)
assert_json "$OUT" '.commands.search' "help lists search command"
assert_json "$OUT" '.commands.post' "help lists post command"
assert_json "$OUT" '.commands.reply' "help lists reply command"
assert_json "$OUT" '.commands.tweet' "help lists tweet command"
assert_json "$OUT" '.commands.user' "help lists user command"
assert_json "$OUT" '.commands.tweets' "help lists tweets command"

echo ""

# ── Results ──

echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "Failures:"
    echo -e "$ERRORS"
    exit 1
fi
