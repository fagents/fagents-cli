#!/usr/bin/env bash
# tts-speak.sh — text-to-speech via OpenAI TTS API + Telegram sendVoice
# All output is JSON. Agents are the users.
#
# Credential loading:
#   --api-key / --token flags for testing/manual use
#   Otherwise, must be called via: sudo -u fagents tts-speak.sh <command>
#   Resolves caller from $SUDO_USER, loads creds from /home/fagents/.agents/<caller>/
#
# Usage:
#   tts-speak.sh <chat-id> <text>            — synthesize + send voice message
#   tts-speak.sh --file <path> <chat-id>     — read text from file

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TELEGRAM_SH="$SCRIPT_DIR/telegram.sh"

OPENAI_API_BASE="https://api.openai.com"
TELEGRAM_API_BASE=""
CREDS_DIR="/home/fagents/.agents"
API_KEY=""
BOT_TOKEN=""
VOICE="alloy"
MODEL="tts-1"
MAX_CHARS=800
INPUT_FILE=""

err() {
    jq -nc --arg msg "$1" '{error: $msg}'
    exit 1
}

# Parse flags
while [[ "${1:-}" == --* ]]; do
    case "$1" in
        --api-key)           API_KEY="$2"; shift 2 ;;
        --token)             BOT_TOKEN="$2"; shift 2 ;;
        --openai-api-base)   OPENAI_API_BASE="$2"; shift 2 ;;
        --telegram-api-base) TELEGRAM_API_BASE="$2"; shift 2 ;;
        --voice)             VOICE="$2"; shift 2 ;;
        --model)             MODEL="$2"; shift 2 ;;
        --file)              INPUT_FILE="$2"; shift 2 ;;
        *) break ;;
    esac
done

# Resolve OpenAI credentials
CALLER="${SUDO_USER:-}"
if [[ -z "$API_KEY" ]]; then
    [[ -z "$CALLER" ]] && err "Must be called via sudo -u fagents (or use --api-key)"
    OPENAI_CRED="$CREDS_DIR/$CALLER/openai.env"
    [[ -f "$OPENAI_CRED" ]] || err "No OpenAI credentials for $CALLER"
    source "$OPENAI_CRED"
    API_KEY="${OPENAI_API_KEY:-}"
    [[ -n "$API_KEY" ]] || err "OPENAI_API_KEY not set in $OPENAI_CRED"
fi

# Resolve Telegram credentials
if [[ -z "$BOT_TOKEN" ]]; then
    [[ -z "$CALLER" ]] && err "Must be called via sudo -u fagents (or use --token)"
    TELEGRAM_CRED="$CREDS_DIR/$CALLER/telegram.env"
    [[ -f "$TELEGRAM_CRED" ]] || err "No Telegram credentials for $CALLER"
    source "$TELEGRAM_CRED"
    BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
    [[ -n "$BOT_TOKEN" ]] || err "TELEGRAM_BOT_TOKEN not set in $TELEGRAM_CRED"
fi

# Parse positional args
chat_id="${1:-}"
shift || true

# Get text: from --file or from remaining args
if [[ -n "$INPUT_FILE" ]]; then
    [[ -f "$INPUT_FILE" ]] || err "input file not found: $INPUT_FILE"
    text=$(cat "$INPUT_FILE")
else
    text="$*"
fi

[[ -n "$chat_id" ]] || err "usage: tts-speak.sh <chat-id> <text>"
[[ -n "$text" ]] || err "no text provided"

# Truncate
if [[ ${#text} -gt $MAX_CHARS ]]; then
    text="${text:0:$MAX_CHARS}"
fi

# Temp file with cleanup
audio_file=$(mktemp /tmp/tts-XXXXXX.ogg)
cleanup() { rm -f "$audio_file"; }
trap cleanup EXIT

# Call OpenAI TTS API
payload=$(jq -nc \
    --arg model "$MODEL" \
    --arg input "$text" \
    --arg voice "$VOICE" \
    '{model: $model, input: $input, voice: $voice, response_format: "opus"}')

http_status=$(curl -s -o "$audio_file" -w '%{http_code}' --max-time 30 \
    -X POST "${OPENAI_API_BASE}/v1/audio/speech" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null) || {
    err "TTS API connection failed"
}

if [[ "$http_status" -ge 400 ]] 2>/dev/null; then
    error_msg=$(jq -r '.error.message // "TTS API error"' < "$audio_file" 2>/dev/null) || error_msg="TTS API error (HTTP $http_status)"
    err "$error_msg"
fi

file_size=$(wc -c < "$audio_file" | tr -d ' ')
[[ "$file_size" -gt 0 ]] || err "TTS API returned empty response"

# Send via telegram.sh sendVoice
telegram_args=(--token "$BOT_TOKEN")
[[ -n "$TELEGRAM_API_BASE" ]] && telegram_args+=(--api-base "$TELEGRAM_API_BASE")

send_out=$(bash "$TELEGRAM_SH" "${telegram_args[@]}" sendVoice "$chat_id" "$audio_file" 2>/dev/null) || {
    send_err=$(echo "$send_out" | jq -r '.error // "unknown"' 2>/dev/null)
    err "sendVoice failed: $send_err"
}

# Output: telegram result + TTS metadata
echo "$send_out" | jq -c --arg voice "$VOICE" --arg model "$MODEL" --arg chars "${#text}" \
    '. + {voice: $voice, model: $model, text_chars: ($chars | tonumber)}'
