#!/usr/bin/env bash
# Tests for stt-transcribe.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="$SCRIPT_DIR/stt-transcribe.sh"

PASS=0; FAIL=0; ERRORS=""
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  FAIL: $1"; echo "  FAIL: $1"; }
assert_eq() { [ "$1" = "$2" ] && pass "$3" || fail "$3 (expected '$1', got '$2')"; }
assert_contains() { echo "$1" | grep -q "$2" && pass "$3" || fail "$3 (expected to contain '$2')"; }
assert_json() { echo "$1" | jq -e "$2" >/dev/null 2>&1 && pass "$3" || fail "$3 (jq: $2)"; }

# ── Mock servers ──

TELEGRAM_MOCK_PORT=0
TELEGRAM_MOCK_PID=""
OPENAI_MOCK_PORT=0
OPENAI_MOCK_PID=""
MOCK_DIR=$(mktemp -d)

start_telegram_mock() {
    TELEGRAM_MOCK_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")

    # Default: getFile returns a file_path, file download returns fake audio bytes
    cat > "$MOCK_DIR/getFile.json" <<'EOF'
{"ok":true,"result":{"file_id":"test-file-id","file_unique_id":"unique123","file_path":"voice/file_0.oga","file_size":4096}}
EOF

    python3 -c "
import http.server, os, sys

PORT = int(sys.argv[1])
DATA_DIR = sys.argv[2]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        parts = path.strip('/').split('/')
        # File download: /file/bot<token>/<file_path>
        if parts[0] == 'file' and len(parts) >= 3:
            self.send_response(200)
            self.send_header('Content-Type', 'audio/ogg')
            self.end_headers()
            self.wfile.write(b'OggS-fake-voice-audio')
            return
        # Bot API: /bot<token>/getFile
        if len(parts) >= 2:
            endpoint = parts[-1]
            qs = self.path.split('?', 1)[1] if '?' in self.path else ''
            with open(os.path.join(DATA_DIR, 'last-telegram-query.txt'), 'w') as f:
                f.write(qs)
            fpath = os.path.join(DATA_DIR, endpoint + '.json')
            if os.path.exists(fpath):
                with open(fpath) as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(data.encode())
                return
        self.send_response(404)
        self.end_headers()
    def log_message(self, *args):
        pass

server = http.server.HTTPServer(('127.0.0.1', PORT), Handler)
server.serve_forever()
" "$TELEGRAM_MOCK_PORT" "$MOCK_DIR" &
    TELEGRAM_MOCK_PID=$!
    sleep 0.3
}

start_openai_mock() {
    OPENAI_MOCK_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")

    python3 -c "
import http.server, os, sys

PORT = int(sys.argv[1])
DATA_DIR = sys.argv[2]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length) if length else b''
        # Save multipart body (binary-safe)
        try:
            body = raw.decode()
        except UnicodeDecodeError:
            body = raw.decode('latin-1')
        with open(os.path.join(DATA_DIR, 'last-whisper-post.txt'), 'w') as f:
            f.write(body)
        # Error mode
        error_file = os.path.join(DATA_DIR, 'whisper-error.json')
        if os.path.exists(error_file):
            with open(error_file) as f:
                data = f.read()
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(data.encode())
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{\"text\":\"Hello from the voice message\"}')
    def log_message(self, *args):
        pass

server = http.server.HTTPServer(('127.0.0.1', PORT), Handler)
server.serve_forever()
" "$OPENAI_MOCK_PORT" "$MOCK_DIR" &
    OPENAI_MOCK_PID=$!
    sleep 0.3
}

stop_mocks() {
    [ -n "$TELEGRAM_MOCK_PID" ] && kill "$TELEGRAM_MOCK_PID" 2>/dev/null; wait "$TELEGRAM_MOCK_PID" 2>/dev/null || true
    [ -n "$OPENAI_MOCK_PID" ] && kill "$OPENAI_MOCK_PID" 2>/dev/null; wait "$OPENAI_MOCK_PID" 2>/dev/null || true
    rm -rf "$MOCK_DIR"
}

set_whisper_error() {
    echo "$1" > "$MOCK_DIR/whisper-error.json"
}

clear_whisper_error() {
    rm -f "$MOCK_DIR/whisper-error.json"
}

set_getfile_error() {
    echo "$1" > "$MOCK_DIR/getFile.json"
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
start_telegram_mock
start_openai_mock

echo "=== stt-transcribe.sh tests ==="
echo ""

# ── basic success ──

echo "basic pipeline:"

OUT=$(run "test-file-id")
assert_json "$OUT" '.text == "Hello from the voice message"' "returns transcribed text"
assert_json "$OUT" '.model == "whisper-1"' "returns model"
assert_json "$OUT" '.file_id == "test-file-id"' "returns file_id"

echo ""

# ── Telegram getFile query ──

echo "Telegram download:"

QUERY=$(cat "$MOCK_DIR/last-telegram-query.txt" 2>/dev/null)
assert_contains "$QUERY" "file_id=test-file-id" "getFile receives file_id"

echo ""

# ── Whisper request ──

echo "Whisper request:"

WHISPER_BODY=$(cat "$MOCK_DIR/last-whisper-post.txt" 2>/dev/null)
assert_contains "$WHISPER_BODY" "whisper-1" "Whisper request has model"
assert_contains "$WHISPER_BODY" "OggS-fake-voice-audio" "Whisper request has audio data"

echo ""

# ── custom model ──

echo "custom flags:"

OUT=$(run --model "gpt-4o-mini-transcribe" "test-file-id")
assert_json "$OUT" '.model == "gpt-4o-mini-transcribe"' "custom model in output"

WHISPER_BODY=$(cat "$MOCK_DIR/last-whisper-post.txt" 2>/dev/null)
assert_contains "$WHISPER_BODY" "gpt-4o-mini-transcribe" "custom model in Whisper request"

echo ""

# ── --language flag ──

echo "language flag:"

OUT=$(run --language "fi" "test-file-id")
WHISPER_BODY=$(cat "$MOCK_DIR/last-whisper-post.txt" 2>/dev/null)
assert_contains "$WHISPER_BODY" "fi" "language sent to Whisper"

echo ""

# ── --audio-file flag (skip download) ──

echo "audio-file flag:"

AUDIO_FILE=$(mktemp)
echo "local-audio-data" > "$AUDIO_FILE"

OUT=$(bash "$CLIENT" \
    --api-key "test-openai-key" \
    --openai-api-base "http://127.0.0.1:$OPENAI_MOCK_PORT" \
    --audio-file "$AUDIO_FILE" 2>/dev/null)
assert_json "$OUT" '.text == "Hello from the voice message"' "audio-file mode works"
assert_json "$OUT" '.file_id == null' "audio-file mode has null file_id"

WHISPER_BODY=$(cat "$MOCK_DIR/last-whisper-post.txt" 2>/dev/null)
assert_contains "$WHISPER_BODY" "local-audio-data" "audio-file content sent to Whisper"

rm -f "$AUDIO_FILE"

echo ""

# ── errors ──

echo "errors:"

# Missing file_id
OUT=$(run 2>/dev/null) || true
assert_json "$OUT" '.error' "missing file_id gives error"

# Missing audio file
OUT=$(bash "$CLIENT" \
    --api-key "test-openai-key" \
    --openai-api-base "http://127.0.0.1:$OPENAI_MOCK_PORT" \
    --audio-file /nonexistent/file 2>/dev/null) || true
assert_contains "$OUT" "audio file not found" "missing audio file gives error"

# Missing credentials
OUT=$(bash "$CLIENT" "some-file-id" 2>/dev/null) || true
assert_json "$OUT" '.error' "missing credentials gives error"
assert_contains "$OUT" "sudo" "error mentions sudo"

echo ""

# ── Telegram getFile error ──

echo "Telegram errors:"

set_getfile_error '{"ok":false,"error_code":400,"description":"Bad Request: invalid file_id"}'
OUT=$(run "bad-file-id" 2>/dev/null) || true
assert_contains "$OUT" "invalid file_id" "getFile error propagated"

# Restore
cat > "$MOCK_DIR/getFile.json" <<'EOF'
{"ok":true,"result":{"file_id":"test-file-id","file_unique_id":"unique123","file_path":"voice/file_0.oga","file_size":4096}}
EOF

echo ""

# ── Whisper API error ──

echo "Whisper errors:"

set_whisper_error '{"error":{"message":"Invalid API key"}}'
OUT=$(run "test-file-id" 2>/dev/null) || true
assert_contains "$OUT" "Invalid API key" "Whisper API error propagated"
clear_whisper_error

echo ""

# ── temp file cleanup ──

echo "cleanup:"

BEFORE=$(ls /tmp/stt-*.oga 2>/dev/null | wc -l | tr -d ' ')
OUT=$(run "test-file-id")
AFTER=$(ls /tmp/stt-*.oga 2>/dev/null | wc -l | tr -d ' ')
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
