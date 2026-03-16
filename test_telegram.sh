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
    cat > "$MOCK_DIR/sendVoice.json" <<'EOF'
{"ok":true,"result":{"message_id":2,"chat":{"id":456,"type":"private"},"voice":{"duration":5,"file_id":"abc123"}}}
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
        raw = self.rfile.read(length) if length else b''
        # Save last POST body for inspection (text for JSON, binary-safe for multipart)
        try:
            body = raw.decode()
        except UnicodeDecodeError:
            body = raw.decode('latin-1')
        with open(os.path.join(DATA_DIR, 'last-post.txt'), 'w') as f:
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
POSTED=$(cat "$MOCK_DIR/last-post.txt" 2>/dev/null)
assert_json "$POSTED" '.chat_id == "456"' "send posts correct chat_id"
assert_json "$POSTED" '.text == "hello world"' "send posts correct text"

# Missing args
OUT=$(run send 2>/dev/null) || true
assert_json "$OUT" '.error' "send missing args gives error"

echo ""

# ── sendVoice ──

echo "sendVoice:"

VOICE_FILE=$(mktemp)
echo "fake-opus-data" > "$VOICE_FILE"

OUT=$(run sendVoice 456 "$VOICE_FILE")
assert_json "$OUT" '.message_id == 2' "sendVoice returns message_id"
assert_json "$OUT" '.chat_id == 456' "sendVoice returns chat_id"
assert_json "$OUT" '.duration == 5' "sendVoice returns duration"

# Verify multipart body contains chat_id and file content
POSTED=$(cat "$MOCK_DIR/last-post.txt" 2>/dev/null)
assert_contains "$POSTED" "456" "sendVoice posts chat_id"
assert_contains "$POSTED" "fake-opus-data" "sendVoice posts voice file content"

# Missing args
OUT=$(run sendVoice 2>/dev/null) || true
assert_json "$OUT" '.error' "sendVoice missing args gives error"

# Missing file
OUT=$(run sendVoice 456 /nonexistent/path 2>/dev/null) || true
assert_contains "$OUT" "file not found" "sendVoice missing file gives error"

rm -f "$VOICE_FILE"

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
assert_json "$OUT" '.type == "text"' "poll text message has type text"

echo ""

# ── poll voice messages ──

echo "poll (voice):"

set_mock getUpdates '{"ok":true,"result":[{"update_id":150,"message":{"message_id":10,"chat":{"id":789,"type":"private"},"from":{"id":1,"is_bot":false,"first_name":"Tester","username":"tester"},"voice":{"duration":3,"file_id":"voice-file-abc","file_unique_id":"unique123","file_size":4096},"date":1709600010}}]}'

OUT=$(run poll)
assert_json "$OUT" '.type == "voice"' "poll voice message has type voice"
assert_json "$OUT" '.file_id == "voice-file-abc"' "poll voice message has file_id"
assert_json "$OUT" '.duration == 3' "poll voice message has duration"
assert_json "$OUT" '.text == null' "poll voice message has null text"
assert_json "$OUT" '.chat_id == 789' "poll voice message has chat_id"
assert_json "$OUT" '.from == "tester"' "poll voice message has from"

echo ""

# ── poll mixed text + voice ──

echo "poll (mixed text + voice):"

set_mock getUpdates '{"ok":true,"result":[{"update_id":160,"message":{"message_id":11,"chat":{"id":789,"type":"private"},"from":{"id":1,"is_bot":false,"first_name":"Tester","username":"tester"},"text":"text msg","date":1709600020}},{"update_id":161,"message":{"message_id":12,"chat":{"id":789,"type":"private"},"from":{"id":1,"is_bot":false,"first_name":"Tester","username":"tester"},"voice":{"duration":5,"file_id":"voice-file-def","file_unique_id":"unique456","file_size":8192},"date":1709600021}}]}'

OUT=$(run poll)
LINES=$(echo "$OUT" | wc -l | tr -d ' ')
assert_eq "2" "$LINES" "poll outputs both text and voice messages"
LINE1=$(echo "$OUT" | head -1)
LINE2=$(echo "$OUT" | tail -1)
assert_json "$LINE1" '.type == "text"' "first message is text"
assert_json "$LINE2" '.type == "voice"' "second message is voice"
assert_json "$LINE2" '.file_id == "voice-file-def"' "voice message has correct file_id"

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
assert_eq "1" "$LINES" "poll filters to text+voice only (skips edits, callbacks)"
assert_json "$OUT" '.text == "real msg"' "poll returns the text message"

# ── poll reply_to ──

echo ""
echo "poll (reply_to):"

set_mock getUpdates '{"ok":true,"result":[{"update_id":500,"message":{"message_id":20,"chat":{"id":789,"type":"group"},"from":{"id":1,"is_bot":false,"first_name":"Tester","username":"tester"},"text":"@bot check this","date":1709600020,"reply_to_message":{"message_id":19,"chat":{"id":789,"type":"group"},"from":{"id":2,"is_bot":false,"first_name":"Alice","username":"alice"},"text":"original message here","date":1709600010}}}]}'

OUT=$(run poll)
assert_json "$OUT" '.reply_to.from == "alice"' "reply_to includes original sender"
assert_json "$OUT" '.reply_to.text == "original message here"' "reply_to includes original text"
assert_json "$OUT" '.reply_to.date == 1709600010' "reply_to includes original date"
assert_json "$OUT" '.text == "@bot check this"' "reply message text preserved"

# Non-reply message should not have reply_to
set_mock getUpdates '{"ok":true,"result":[{"update_id":501,"message":{"message_id":21,"chat":{"id":789,"type":"private"},"from":{"id":1,"is_bot":false,"first_name":"Tester","username":"tester"},"text":"no reply","date":1709600021}}]}'

OUT=$(run poll)
assert_json "$OUT" '.reply_to == null' "non-reply message has no reply_to"

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

# ── allowed users gate ──

echo "allowed users gate:"

# Set up updates with from.id=42
set_mock getUpdates '{"ok":true,"result":[{"update_id":400,"message":{"message_id":4,"chat":{"id":789,"type":"private"},"from":{"id":42,"is_bot":false,"first_name":"Trusted","username":"trusted"},"text":"allowed msg","date":1709600004}},{"update_id":401,"message":{"message_id":5,"chat":{"id":790,"type":"private"},"from":{"id":99,"is_bot":false,"first_name":"Stranger","username":"stranger"},"text":"blocked msg","date":1709600005}}]}'

# With TELEGRAM_ALLOWED_IDS=42, only from.id=42 should pass
OUT=$(TELEGRAM_ALLOWED_IDS="42" run poll)
LINES=$(echo "$OUT" | wc -l | tr -d ' ')
assert_eq "1" "$LINES" "gate passes only allowed user"
assert_json "$OUT" '.from == "trusted"' "gate passes correct user"
assert_json "$OUT" '.text == "allowed msg"' "gate passes correct message"

# With TELEGRAM_ALLOWED_IDS=99, only from.id=99 should pass
OUT=$(TELEGRAM_ALLOWED_IDS="99" run poll)
assert_json "$OUT" '.from == "stranger"' "gate passes different allowed user"

# With TELEGRAM_ALLOWED_IDS not set, both pass
set_mock getUpdates '{"ok":true,"result":[{"update_id":400,"message":{"message_id":4,"chat":{"id":789,"type":"private"},"from":{"id":42,"is_bot":false,"first_name":"Trusted","username":"trusted"},"text":"allowed msg","date":1709600004}},{"update_id":401,"message":{"message_id":5,"chat":{"id":790,"type":"private"},"from":{"id":99,"is_bot":false,"first_name":"Stranger","username":"stranger"},"text":"blocked msg","date":1709600005}}]}'
OUT=$(run poll)
LINES=$(echo "$OUT" | wc -l | tr -d ' ')
assert_eq "2" "$LINES" "no gate allows all messages"

# With TELEGRAM_ALLOWED_IDS set to non-matching ID, nothing passes
OUT=$(TELEGRAM_ALLOWED_IDS="999" run poll 2>/dev/null) ; RC=$?
assert_eq "1" "$RC" "gate blocks all non-matching users (exit 1)"

# Multiple allowed users (comma-separated)
set_mock getUpdates '{"ok":true,"result":[{"update_id":400,"message":{"message_id":4,"chat":{"id":789,"type":"private"},"from":{"id":42,"is_bot":false,"first_name":"Trusted","username":"trusted"},"text":"msg1","date":1709600004}},{"update_id":401,"message":{"message_id":5,"chat":{"id":790,"type":"private"},"from":{"id":99,"is_bot":false,"first_name":"Stranger","username":"stranger"},"text":"msg2","date":1709600005}}]}'
OUT=$(TELEGRAM_ALLOWED_IDS="42,99" run poll)
LINES=$(echo "$OUT" | wc -l | tr -d ' ')
assert_eq "2" "$LINES" "gate allows multiple comma-separated user IDs"

echo ""

# ── Results ──

echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "Failures:"
    echo -e "$ERRORS"
    exit 1
fi
