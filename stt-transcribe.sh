#!/usr/bin/env bash
# stt-transcribe.sh — speech-to-text via Telegram file download + OpenAI Whisper API
# All output is JSON. Agents are the users.
#
# Credential loading:
#   --api-key / --token flags for testing/manual use
#   Otherwise, must be called via: sudo -u fagents stt-transcribe.sh <command>
#   Resolves caller from $SUDO_USER, loads creds from /home/fagents/.agents/<caller>/
#
# Usage:
#   stt-transcribe.sh <file-id>                — download from Telegram + transcribe
#   stt-transcribe.sh --audio-file <path>      — transcribe local audio file (skip download)

set -euo pipefail

OPENAI_API_BASE="https://api.openai.com"
TELEGRAM_API_BASE="https://api.telegram.org"
CREDS_DIR="/home/fagents/.agents"
API_KEY=""
BOT_TOKEN=""
MODEL="whisper-1"
LANGUAGE=""
AUDIO_FILE=""

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
        --model)             MODEL="$2"; shift 2 ;;
        --language)          LANGUAGE="$2"; shift 2 ;;
        --audio-file)        AUDIO_FILE="$2"; shift 2 ;;
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

# Resolve Telegram credentials (only needed if downloading)
if [[ -z "$AUDIO_FILE" ]] && [[ -z "$BOT_TOKEN" ]]; then
    [[ -z "$CALLER" ]] && err "Must be called via sudo -u fagents (or use --token)"
    TELEGRAM_CRED="$CREDS_DIR/$CALLER/telegram.env"
    [[ -f "$TELEGRAM_CRED" ]] || err "No Telegram credentials for $CALLER"
    source "$TELEGRAM_CRED"
    BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
    [[ -n "$BOT_TOKEN" ]] || err "TELEGRAM_BOT_TOKEN not set in $TELEGRAM_CRED"
fi

# Temp file cleanup
tmp_audio=""
cleanup() { [[ -n "$tmp_audio" ]] && rm -f "$tmp_audio"; }
trap cleanup EXIT

file_id=""

if [[ -n "$AUDIO_FILE" ]]; then
    # Local file mode — skip Telegram download
    [[ -f "$AUDIO_FILE" ]] || err "audio file not found: $AUDIO_FILE"
    tmp_audio=""  # don't clean up caller's file
    transcribe_file="$AUDIO_FILE"
else
    # Telegram download mode
    file_id="${1:-}"
    [[ -n "$file_id" ]] || err "usage: stt-transcribe.sh <file-id>"

    # Step 1: getFile → file_path
    tmpfile=$(mktemp)
    http_status=$(curl -s -o "$tmpfile" -w '%{http_code}' --max-time 10 \
        "${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/getFile?file_id=${file_id}" 2>/dev/null) || {
        rm -f "$tmpfile"
        err "Telegram getFile connection failed"
    }
    getfile_resp=$(cat "$tmpfile")
    rm -f "$tmpfile"

    if [[ "$http_status" -ge 400 ]] 2>/dev/null; then
        err "Telegram getFile failed (HTTP $http_status)"
    fi

    ok=$(echo "$getfile_resp" | jq -r '.ok' 2>/dev/null)
    if [[ "$ok" != "true" ]]; then
        desc=$(echo "$getfile_resp" | jq -r '.description // "getFile failed"' 2>/dev/null)
        err "$desc"
    fi

    file_path=$(echo "$getfile_resp" | jq -r '.result.file_path' 2>/dev/null)
    [[ -n "$file_path" ]] && [[ "$file_path" != "null" ]] || err "getFile returned no file_path"

    # Step 2: download the file
    tmp_audio=$(mktemp /tmp/stt-XXXXXX.oga)
    http_status=$(curl -s -o "$tmp_audio" -w '%{http_code}' --max-time 30 \
        "${TELEGRAM_API_BASE}/file/bot${BOT_TOKEN}/${file_path}" 2>/dev/null) || {
        err "Telegram file download failed"
    }

    if [[ "$http_status" -ge 400 ]] 2>/dev/null; then
        err "Telegram file download failed (HTTP $http_status)"
    fi

    file_size=$(wc -c < "$tmp_audio" | tr -d ' ')
    [[ "$file_size" -gt 0 ]] || err "Downloaded file is empty"

    transcribe_file="$tmp_audio"
fi

# Step 3: Whisper transcription
whisper_args=(-F "file=@$transcribe_file" -F "model=$MODEL" -F "response_format=json")
[[ -n "$LANGUAGE" ]] && whisper_args+=(-F "language=$LANGUAGE")

whisper_out=$(mktemp)
http_status=$(curl -s -o "$whisper_out" -w '%{http_code}' --max-time 30 \
    -X POST "${OPENAI_API_BASE}/v1/audio/transcriptions" \
    -H "Authorization: Bearer $API_KEY" \
    "${whisper_args[@]}" 2>/dev/null) || {
    rm -f "$whisper_out"
    err "Whisper API connection failed"
}

whisper_resp=$(cat "$whisper_out")
rm -f "$whisper_out"

if [[ "$http_status" -ge 400 ]] 2>/dev/null; then
    error_msg=$(echo "$whisper_resp" | jq -r '.error.message // "Whisper API error"' 2>/dev/null) || error_msg="Whisper API error (HTTP $http_status)"
    err "$error_msg"
fi

text=$(echo "$whisper_resp" | jq -r '.text // empty' 2>/dev/null)
[[ -n "$text" ]] || err "Whisper returned empty transcription"

# Output
jq -nc --arg text "$text" --arg model "$MODEL" --arg file_id "$file_id" \
    '{text: $text, model: $model, file_id: (if $file_id == "" then null else $file_id end)}'
