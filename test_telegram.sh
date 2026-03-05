#!/usr/bin/env bash
# Tests for telegram.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="$SCRIPT_DIR/telegram.sh"

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
    cat > "$MOCK_DIR/getMe.json" <<'EOF'
{"ok":true,"result":{"id":123,"is_bot":true,"first_name":"TestBot","username":"testbot"}}
EOF
    cat > "$MOCK_DIR/sendMessage.json" <<'EOF'
{"ok":true,"result":{"message_id":1,"chat":{"id":456,"type":"private"},"text":"hello"}}
EOF
    cat > "$MOCK_DIR/getUpdates.json" <<'EOF'
{"ok":true,"result":[{"update_id":100,"message":{"message_id":1,"chat":{"id":789,"type":"private"},"from":{"id":1,"is_bot":false,"first_name":"Tester","username":"tester"},"text":"hello","date":1709600000}}]}
EOF

    python3 -c "
import http.server, os, sys, json

PORT = int(sys.argv[1])
DATA_DIR = sys.argv[2]

class Handler(http.server.BaseHTTPRequestHandler):
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
            self.wfile.write(b'{\"ok\":false,\"description\":\"mock: file not found\"}')
    def do_GET(self):
        path = self.path.split('?')[0]
        # Extract endpoint from /bot<token>/endpoint
        parts = path.strip('/').split('/')
        if len(parts) >= 2:
            endpoint = parts[-1]
            # Save query string for inspection
            qs = self.path.split('?', 1)[1] if '?' in self.path else ''
            with open(os.path.join(DATA_DIR, 'last-query.txt'), 'w') as f:
                f.write(qs)
            self._serve(endpoint + '.json')
        else:
            self.send_response(404)
            self.end_headers()
    def do_POST(self):
        path = self.path.split('?')[0]
        parts = path.strip('/').split('/')
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode() if length else ''
        # Save last POST body for inspection
        with open(os.path.join(DATA_DIR, 'last-post.json'), 'w') as f:
            f.write(body)
        if len(parts) >= 2:
            endpoint = parts[-1]
            self._serve(endpoint + '.json')
        else:
            self.send_response(404)
            self.end_headers()
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
    bash "$CLIENT" --token "test-token-123" --api-base "http://127.0.0.1:$MOCK_PORT" "$@" 2>/dev/null
}

trap stop_mock EXIT
start_mock

echo "=== telegram.sh tests ==="
echo ""

# ── whoami ──

echo "whoami:"

OUT=$(run whoami)
assert_json "$OUT" '.id == 123' "whoami returns bot id"
assert_json "$OUT" '.is_bot == true' "whoami returns is_bot"
assert_json "$OUT" '.username == "testbot"' "whoami returns username"

echo ""

# ── send ──

echo "send:"

OUT=$(run send 456 "hello world")
assert_json "$OUT" '.message_id == 1' "send returns message_id"
assert_json "$OUT" '.chat_id == 456' "send returns chat_id"

# Verify POST body
POSTED=$(cat "$MOCK_DIR/last-post.json" 2>/dev/null)
assert_json "$POSTED" '.chat_id == "456"' "send posts correct chat_id"
assert_json "$POSTED" '.text == "hello world"' "send posts correct text"

# Missing args
OUT=$(run send 2>/dev/null) || true
assert_json "$OUT" '.error' "send missing args gives error"

echo ""

# ── poll ──

echo "poll:"

OUT=$(run poll)
LINES=$(echo "$OUT" | wc -l | tr -d ' ')
assert_eq "1" "$LINES" "poll outputs 1 message line"
assert_json "$OUT" '.update_id == 100' "poll returns update_id"
assert_json "$OUT" '.chat_id == 789' "poll returns chat_id"
assert_json "$OUT" '.from == "tester"' "poll returns from username"
assert_json "$OUT" '.text == "hello"' "poll returns text"
assert_json "$OUT" '.date == 1709600000' "poll returns date"

echo ""

# ── poll with no updates ──

echo "poll (empty):"

set_mock getUpdates '{"ok":true,"result":[]}'
OUT=$(run poll) ; RC=$?
assert_eq "1" "$RC" "poll with no updates exits 1"

echo ""

# ── poll with offset file ──

echo "poll (offset tracking):"

# Set up a creds dir to test offset tracking
TEST_CREDS_DIR=$(mktemp -d)
TEST_CALLER="testuser"
mkdir -p "$TEST_CREDS_DIR/$TEST_CALLER"
echo "TELEGRAM_BOT_TOKEN=test-token-123" > "$TEST_CREDS_DIR/$TEST_CALLER/telegram.env"

# Restore updates for offset test
set_mock getUpdates '{"ok":true,"result":[{"update_id":200,"message":{"message_id":2,"chat":{"id":789,"type":"private"},"from":{"id":1,"is_bot":false,"first_name":"Tester","username":"tester"},"text":"world","date":1709600001}}]}'

# Run with sudo simulation (set SUDO_USER + CREDS_DIR override)
# We can't easily override CREDS_DIR, so test offset via --token + manual offset file
# Instead, just verify the offset is sent in the query
OUT=$(run poll)
QUERY=$(cat "$MOCK_DIR/last-query.txt" 2>/dev/null)
assert_contains "$QUERY" "offset=" "poll sends offset parameter"

# Clean up test creds
rm -rf "$TEST_CREDS_DIR"

echo ""

# ── poll filters non-text updates ──

echo "poll (filtering):"

set_mock getUpdates '{"ok":true,"result":[{"update_id":300,"message":{"message_id":3,"chat":{"id":789,"type":"private"},"from":{"id":1,"is_bot":false,"first_name":"Tester","username":"tester"},"text":"real msg","date":1709600002}},{"update_id":301,"edited_message":{"message_id":1,"chat":{"id":789},"text":"edited","date":1709600003}},{"update_id":302,"callback_query":{"id":"abc","from":{"id":1},"data":"click"}}]}'

OUT=$(run poll)
LINES=$(echo "$OUT" | wc -l | tr -d ' ')
assert_eq "1" "$LINES" "poll filters to text messages only"
assert_json "$OUT" '.text == "real msg"' "poll returns only text message"

echo ""

# ── credential errors ──

echo "errors:"

# No SUDO_USER and no --token
OUT=$(bash "$CLIENT" whoami 2>/dev/null) || true
assert_json "$OUT" '.error' "missing SUDO_USER and --token gives error"
assert_contains "$OUT" "sudo" "error mentions sudo"

# Missing cred file (simulate SUDO_USER but no file)
OUT=$(SUDO_USER="nonexistent" bash "$CLIENT" --api-base "http://127.0.0.1:$MOCK_PORT" whoami 2>/dev/null) || true
assert_json "$OUT" '.error' "missing cred file gives error"
assert_contains "$OUT" "No credentials" "error mentions missing credentials"

echo ""

# ── API error ──

echo "api errors:"

set_mock getMe '{"ok":false,"error_code":401,"description":"Unauthorized"}'
OUT=$(run whoami 2>/dev/null) || true
assert_json "$OUT" '.error == "Unauthorized"' "API error returns description"

# Restore for further tests
set_mock getMe '{"ok":true,"result":{"id":123,"is_bot":true,"first_name":"TestBot","username":"testbot"}}'

echo ""

# ── help ──

echo "help:"

OUT=$(run help)
assert_json "$OUT" '.commands.send' "help lists send command"
assert_json "$OUT" '.commands.poll' "help lists poll command"
assert_json "$OUT" '.commands.whoami' "help lists whoami command"
assert_json "$OUT" '.flags | length == 2' "help lists flags"

echo ""

# ── Results ──

echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "Failures:"
    echo -e "$ERRORS"
    exit 1
fi
