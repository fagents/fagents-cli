#!/usr/bin/env bash
# Tests for tts-speak.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="$SCRIPT_DIR/tts-speak.sh"

PASS=0; FAIL=0; ERRORS=""
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  FAIL: $1"; echo "  FAIL: $1"; }
assert_eq() { [ "$1" = "$2" ] && pass "$3" || fail "$3 (expected '$1', got '$2')"; }
assert_contains() { echo "$1" | grep -q "$2" && pass "$3" || fail "$3 (expected to contain '$2')"; }
assert_json() { echo "$1" | jq -e "$2" >/dev/null 2>&1 && pass "$3" || fail "$3 (jq: $2)"; }

# ── Mock servers ──

OPENAI_MOCK_PORT=0
OPENAI_MOCK_PID=""
TELEGRAM_MOCK_PORT=0
TELEGRAM_MOCK_PID=""
MOCK_DIR=$(mktemp -d)

start_openai_mock() {
    OPENAI_MOCK_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")

    python3 -c "
import http.server, os, sys

PORT = int(sys.argv[1])
DATA_DIR = sys.argv[2]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode() if length else ''
        with open(os.path.join(DATA_DIR, 'last-tts-post.json'), 'w') as f:
            f.write(body)
        error_file = os.path.join(DATA_DIR, 'tts-error.json')
        if os.path.exists(error_file):
            with open(error_file) as f:
                data = f.read()
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(data.encode())
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'audio/ogg')
            self.end_headers()
            self.wfile.write(b'OggS-fake-opus-audio-data')
    def log_message(self, *args):
        pass

server = http.server.HTTPServer(('127.0.0.1', PORT), Handler)
server.serve_forever()
" "$OPENAI_MOCK_PORT" "$MOCK_DIR" &
    OPENAI_MOCK_PID=$!
    sleep 0.3
}

start_telegram_mock() {
    TELEGRAM_MOCK_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")

    cat > "$MOCK_DIR/sendVoice.json" <<'EOF'
{"ok":true,"result":{"message_id":7,"chat":{"id":456,"type":"private"},"voice":{"duration":5,"file_id":"abc123"}}}
EOF

    python3 -c "
import http.server, os, sys

PORT = int(sys.argv[1])
DATA_DIR = sys.argv[2]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        path = self.path.split('?')[0]
        parts = path.strip('/').split('/')
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length) if length else b''
        if len(parts) >= 2:
            endpoint = parts[-1]
            fpath = os.path.join(DATA_DIR, endpoint + '.json')
            if os.path.exists(fpath):
                with open(fpath) as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(data.encode())
                return
        self.send_response(500)
        self.end_headers()
        self.wfile.write(b'{\"ok\":false,\"description\":\"mock: endpoint not found\"}')
    def log_message(self, *args):
        pass

server = http.server.HTTPServer(('127.0.0.1', PORT), Handler)
server.serve_forever()
" "$TELEGRAM_MOCK_PORT" "$MOCK_DIR" &
    TELEGRAM_MOCK_PID=$!
    sleep 0.3
}

stop_mocks() {
    [ -n "$OPENAI_MOCK_PID" ] && kill "$OPENAI_MOCK_PID" 2>/dev/null; wait "$OPENAI_MOCK_PID" 2>/dev/null || true
    [ -n "$TELEGRAM_MOCK_PID" ] && kill "$TELEGRAM_MOCK_PID" 2>/dev/null; wait "$TELEGRAM_MOCK_PID" 2>/dev/null || true
    rm -rf "$MOCK_DIR"
}

set_tts_error() {
    echo "$1" > "$MOCK_DIR/tts-error.json"
}

clear_tts_error() {
    rm -f "$MOCK_DIR/tts-error.json"
}

run() {
    bash "$CLIENT" \
        --api-key "test-openai-key" \
        --token "test-bot-token" \
        --openai-api-base "http://127.0.0.1:$OPENAI_MOCK_PORT" \
        --telegram-api-base "http://127.0.0.1:$TELEGRAM_MOCK_PORT" \
        "$@" 2>/dev/null
}

trap stop_mocks EXIT
start_openai_mock
start_telegram_mock

echo "=== tts-speak.sh tests ==="
echo ""

# ── basic success ──

echo "basic pipeline:"

OUT=$(run 456 "Hello world")
assert_json "$OUT" '.message_id == 7' "returns message_id from sendVoice"
assert_json "$OUT" '.chat_id == 456' "returns chat_id"
assert_json "$OUT" '.duration == 5' "returns duration"
assert_json "$OUT" '.voice == "alloy"' "returns voice"
assert_json "$OUT" '.model == "tts-1"' "returns model"
assert_json "$OUT" '.text_chars == 11' "returns text_chars"

echo ""

# ── TTS POST body ──

echo "TTS request:"

TTS_BODY=$(cat "$MOCK_DIR/last-tts-post.json" 2>/dev/null)
assert_json "$TTS_BODY" '.model == "tts-1"' "TTS request has model"
assert_json "$TTS_BODY" '.voice == "alloy"' "TTS request has voice"
assert_json "$TTS_BODY" '.input == "Hello world"' "TTS request has input text"
assert_json "$TTS_BODY" '.response_format == "opus"' "TTS request has opus format"

echo ""

# ── custom voice and model ──

echo "custom flags:"

OUT=$(run --voice nova --model tts-1-hd 456 "Test voice")
assert_json "$OUT" '.voice == "nova"' "custom voice in output"
assert_json "$OUT" '.model == "tts-1-hd"' "custom model in output"

TTS_BODY=$(cat "$MOCK_DIR/last-tts-post.json" 2>/dev/null)
assert_json "$TTS_BODY" '.voice == "nova"' "custom voice in TTS request"
assert_json "$TTS_BODY" '.model == "tts-1-hd"' "custom model in TTS request"

echo ""

# ── text truncation ──

echo "truncation:"

LONG_TEXT=$(python3 -c "print('x' * 1000)")
OUT=$(run 456 "$LONG_TEXT")
TTS_BODY=$(cat "$MOCK_DIR/last-tts-post.json" 2>/dev/null)
INPUT_LEN=$(echo "$TTS_BODY" | jq -r '.input | length' 2>/dev/null)
assert_eq "800" "$INPUT_LEN" "text truncated to 800 chars"
assert_json "$OUT" '.text_chars == 800' "text_chars reflects truncation"

echo ""

# ── --file flag ──

echo "file input:"

TEXT_FILE=$(mktemp)
echo "Text from a file" > "$TEXT_FILE"
OUT=$(run --file "$TEXT_FILE" 456)
assert_json "$OUT" '.message_id == 7' "file input works"

TTS_BODY=$(cat "$MOCK_DIR/last-tts-post.json" 2>/dev/null)
assert_contains "$TTS_BODY" "Text from a file" "file content sent to TTS"

rm -f "$TEXT_FILE"

echo ""

# ── error: missing chat_id ──

echo "errors:"

OUT=$(run 2>/dev/null) || true
assert_json "$OUT" '.error' "missing chat_id gives error"

# error: missing text
OUT=$(run 456 2>/dev/null) || true
assert_json "$OUT" '.error' "missing text gives error"

# error: missing input file
OUT=$(run --file /nonexistent/file 456 2>/dev/null) || true
assert_contains "$OUT" "input file not found" "missing input file gives error"

# error: missing credentials (no flags, no SUDO_USER)
OUT=$(bash "$CLIENT" 456 "hello" 2>/dev/null) || true
assert_json "$OUT" '.error' "missing credentials gives error"
assert_contains "$OUT" "sudo" "error mentions sudo"

echo ""

# ── TTS API error ──

echo "TTS API errors:"

set_tts_error '{"error":{"message":"Invalid API key"}}'
OUT=$(run 456 "test" 2>/dev/null) || true
assert_contains "$OUT" "Invalid API key" "TTS API error propagated"
clear_tts_error

echo ""

# ── temp file cleanup ──

echo "cleanup:"

BEFORE=$(ls /tmp/tts-*.ogg 2>/dev/null | wc -l | tr -d ' ')
OUT=$(run 456 "cleanup test")
AFTER=$(ls /tmp/tts-*.ogg 2>/dev/null | wc -l | tr -d ' ')
assert_eq "$BEFORE" "$AFTER" "no temp files leaked"

echo ""

# ── Results ──

echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "Failures:"
    echo -e "$ERRORS"
    exit 1
fi
