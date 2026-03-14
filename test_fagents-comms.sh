#!/usr/bin/env bash
# Tests for fagents-comms.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="$SCRIPT_DIR/fagents-comms.sh"

PASS=0; FAIL=0; ERRORS=""
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  FAIL: $1"; echo "  FAIL: $1"; }
assert_eq() { [ "$1" = "$2" ] && pass "$3" || fail "$3 (expected '$1', got '$2')"; }
assert_contains() { echo "$1" | grep -q "$2" && pass "$3" || fail "$3 (expected to contain '$2')"; }
assert_json() { echo "$1" | jq -e "$2" >/dev/null 2>&1 && pass "$3" || fail "$3 (jq: $2)"; }

# ── Mock server ──

MOCK_PORT=0
MOCK_DIR=$(mktemp -d)
MOCK_PID=""

start_mock() {
    MOCK_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")
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
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/whoami':
            self._serve('whoami.json')
        elif path == '/api/poll':
            self._serve('poll.json')
        elif path == '/api/unread':
            self._serve('unread.json')
        elif path == '/api/channels':
            self._serve('channels.json')
        elif path.startswith('/api/channels/') and path.endswith('/messages'):
            self._serve('history.json')
        else:
            self.send_response(404)
            self.end_headers()
    def do_POST(self):
        path = self.path.split('?')[0]
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode() if length else ''
        if path == '/api/agents':
            data = json.loads(body) if body else {}
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': True, 'agent': data.get('name',''), 'token': 'mock-token-abc'}).encode())
        elif path == '/api/channels':
            data = json.loads(body) if body else {}
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': True, 'channel': data.get('name',''), 'allow': data.get('allow', ['*'])}).encode())
        elif path.startswith('/api/channels/') and path.endswith('/messages'):
            data = json.loads(body) if body else {}
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            ch = path.split('/')[3]
            self.wfile.write(json.dumps({'ok': True, 'message': {'ts': '2026-03-04 09:00 EET', 'sender': 'test', 'message': data.get('message',''), 'channel': ch, 'type': 'chat'}}).encode())
        else:
            self.send_response(404)
            self.end_headers()
    def do_PUT(self):
        path = self.path.split('?')[0]
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode() if length else ''
        if path.startswith('/api/agents/') and path.endswith('/channels'):
            data = json.loads(body) if body else {}
            agent = path.split('/')[3]
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': True, 'agent': agent, 'channels': data.get('channels', [])}).encode())
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
}

set_mock() {
    echo "$2" > "$MOCK_DIR/$1.json"
}

run() {
    COMMS_URL="http://127.0.0.1:$MOCK_PORT" COMMS_TOKEN="test-token" bash "$CLIENT" "$@" 2>/dev/null
}

trap stop_mock EXIT
start_mock

echo "=== fagents-comms.sh tests ==="
echo ""

# ── whoami ──

echo "whoami:"

set_mock whoami '{"agent":"testbot","subscriptions":["general","dev"],"channels":[{"name":"general","message_count":100}],"agents":["testbot","admin"],"health":{}}'

OUT=$(run whoami)
assert_json "$OUT" '.agent == "testbot"' "whoami returns agent name"
assert_json "$OUT" '.subscriptions | length == 2' "whoami shows subscriptions"
assert_json "$OUT" '.agents | length == 2' "whoami shows agents"

echo ""

# ── poll ──

echo "poll:"

set_mock poll '{"total":1000,"unread":5,"channels":3}'

OUT=$(run poll)
assert_json "$OUT" '.unread == 5' "poll shows unread count"
assert_json "$OUT" '.total == 1000' "poll shows total"
assert_json "$OUT" '.channels == 3' "poll shows channel count"

echo ""

# ── send ──

echo "send:"

OUT=$(run send general "hello world")
assert_json "$OUT" '.ok == true' "send returns ok"
assert_json "$OUT" '.message.channel == "general"' "send echoes channel"
assert_json "$OUT" '.message.message == "hello world"' "send echoes message"

echo ""

# ── fetch ──

echo "fetch:"

set_mock unread '{"agent":"testbot","channels":[{"channel":"general","unread_count":2,"messages":[{"ts":"2026-03-04 09:00 EET","sender":"alice","message":"hey"},{"ts":"2026-03-04 09:01 EET","sender":"bob","message":"hi"}]}]}'

OUT=$(run fetch)
LINES=$(echo "$OUT" | wc -l | tr -d ' ')
assert_eq "2" "$LINES" "fetch outputs 2 message lines"
FIRST=$(echo "$OUT" | head -1)
assert_json "$FIRST" '.from == "alice"' "fetch first message from alice"
assert_json "$FIRST" '.channel == "general"' "fetch first message channel"
SECOND=$(echo "$OUT" | tail -1)
assert_json "$SECOND" '.from == "bob"' "fetch second message from bob"

echo ""

# ── register ──

echo "register:"

OUT=$(run register newbot --type ai)
assert_json "$OUT" '.ok == true' "register returns ok"
assert_json "$OUT" '.agent == "newbot"' "register returns agent name"
assert_json "$OUT" '.token == "mock-token-abc"' "register returns token"

echo ""

# ── subscribe ──

echo "subscribe:"

OUT=$(run subscribe dev ops)
assert_json "$OUT" '.ok == true' "subscribe returns ok"
# Should merge existing [general, dev] + new [dev, ops] = [general, dev, ops]
assert_json "$OUT" '.channels | length == 3' "subscribe merges channels (3 total)"
assert_json "$OUT" '.channels | index("ops") != null' "subscribe includes new channel"
assert_json "$OUT" '.channels | index("general") != null' "subscribe keeps existing channel"

echo ""

# ── error handling ──

echo "errors:"

OUT=$(COMMS_URL="http://127.0.0.1:$MOCK_PORT" COMMS_TOKEN="" bash "$CLIENT" whoami 2>/dev/null) || true
assert_json "$OUT" '.error == "COMMS_TOKEN not set"' "missing token gives JSON error"

OUT=$(run send 2>/dev/null) || true
assert_json "$OUT" '.error' "missing args gives JSON error"

echo ""

# ── history ──

echo "history:"

set_mock history '{"channel":"general","count":3,"messages":[{"ts":"2026-03-04 09:00 EET","sender":"alice","message":"first","channel":"general"},{"ts":"2026-03-04 09:01 EET","sender":"bob","message":"second","channel":"general"},{"ts":"2026-03-04 09:02 EET","sender":"carol","message":"third","channel":"general"}]}'

OUT=$(run history general)
LINES=$(echo "$OUT" | wc -l | tr -d ' ')
assert_eq "3" "$LINES" "history outputs 3 message lines"
FIRST=$(echo "$OUT" | head -1)
assert_json "$FIRST" '.from == "alice"' "history first message from alice"
assert_json "$FIRST" '.channel == "general"' "history message has channel"
LAST=$(echo "$OUT" | tail -1)
assert_json "$LAST" '.from == "carol"' "history last message from carol"

# Missing channel arg
OUT=$(run history 2>/dev/null) || true
assert_json "$OUT" '.error' "history without channel gives error"

echo ""

# ── create-channel ──

echo "create-channel:"

OUT=$(run create-channel dev-chat)
assert_json "$OUT" '.ok == true' "create-channel returns ok"
assert_json "$OUT" '.channel == "dev-chat"' "create-channel returns channel name"
assert_json "$OUT" '.allow == ["*"]' "create-channel default allow is [*]"

OUT=$(run create-channel private --allow alice,bob)
assert_json "$OUT" '.ok == true' "create-channel with --allow returns ok"
assert_json "$OUT" '.allow | length == 2' "create-channel --allow has 2 entries"

OUT=$(run create-channel 2>/dev/null) || true
assert_json "$OUT" '.error' "create-channel missing name gives error"

echo ""

# ── help ──

echo "help:"

OUT=$(run help)
assert_json "$OUT" '.commands."create-channel"' "help lists create-channel command"
assert_json "$OUT" '.commands.send' "help lists send command"
assert_json "$OUT" '.commands.poll' "help lists poll command"
assert_json "$OUT" '.commands.history' "help lists history command"
assert_json "$OUT" '.config.COMMS_TOKEN' "help lists COMMS_TOKEN"

echo ""

# ── Results ──

echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "Failures:"
    echo -e "$ERRORS"
    exit 1
fi
