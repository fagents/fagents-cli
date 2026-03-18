#!/usr/bin/env bash
# telegram.sh — agent-first Telegram Bot API client
# All output is JSON. Agents are the users.
#
# Credential loading:
#   --token flag for testing/manual use
#   Otherwise, must be called via: sudo -u fagents telegram.sh <command>
#   Resolves caller from $SUDO_USER, loads creds from /home/fagents/.agents/<caller>/
#
# Commands:
#   telegram.sh whoami                        — verify bot token (getMe)
#   telegram.sh send <chat-id> <message>      — send message to chat
#   telegram.sh sendVoice <chat-id> <file>    — send voice message (OGG/Opus)
#   telegram.sh poll                          — get new DMs (text + voice + attachments, one JSON per msg)
#   telegram.sh download <file-id> [dir]      — download file by file_id, outputs {path, size}

set -euo pipefail

API_BASE="https://api.telegram.org"
CREDS_DIR="/home/fagents/.agents"
TOKEN=""
OFFSET_FILE=""

err() {
    jq -nc --arg msg "$1" '{error: $msg}'
    exit 1
}

# Parse global flags before command
while [[ "${1:-}" == --* ]]; do
    case "$1" in
        --token)     TOKEN="$2"; shift 2 ;;
        --api-base)  API_BASE="$2"; shift 2 ;;
        *) break ;;
    esac
done

# Resolve credentials
CALLER="${SUDO_USER:-}"
if [[ -z "$TOKEN" ]]; then
    [[ -z "$CALLER" ]] && err "Must be called via sudo -u fagents (or use --token)"
    CRED_FILE="$CREDS_DIR/$CALLER/telegram.env"
    [[ -f "$CRED_FILE" ]] || err "No credentials for $CALLER"
    source "$CRED_FILE"
    TOKEN="${TELEGRAM_BOT_TOKEN:-}"
    [[ -n "$TOKEN" ]] || err "TELEGRAM_BOT_TOKEN not set in $CRED_FILE"
    OFFSET_FILE="$CREDS_DIR/$CALLER/telegram-offset"
fi

# Allowed user IDs gate: comma-separated Telegram user IDs (numeric, permanent)
# If set, poll only outputs messages from these IDs. Others are silently consumed.
ALLOWED="${TELEGRAM_ALLOWED_IDS:-}"

# HTTP helper — calls Bot API, sets BOT_RESP on success, outputs JSON error + exits on failure
BOT_RESP=""
bot_api() {
    local method="$1" endpoint="$2"
    shift 2
    local url="${API_BASE}/bot${TOKEN}/${endpoint}"
    local tmpfile
    tmpfile=$(mktemp)
    local status
    status=$(curl -s -o "$tmpfile" -w '%{http_code}' --max-time 10 \
        -X "$method" "$@" "$url" 2>/dev/null) || {
        rm -f "$tmpfile"
        err "connection failed: $endpoint"
    }
    local body
    body=$(cat "$tmpfile")
    rm -f "$tmpfile"
    if [[ "$status" -ge 200 ]] && [[ "$status" -lt 300 ]] 2>/dev/null; then
        # Check Telegram API-level error
        local ok
        ok=$(echo "$body" | jq -r '.ok' 2>/dev/null) || true
        if [[ "$ok" == "false" ]]; then
            local desc
            desc=$(echo "$body" | jq -r '.description // "unknown error"' 2>/dev/null)
            jq -nc --arg err "$desc" '{error: $err}'
            exit 1
        fi
        BOT_RESP="$body"
    else
        jq -nc --arg err "$body" --arg status "$status" '{error: $err, status: ($status | tonumber)}'
        exit 1
    fi
}

cmd="${1:-help}"
shift || true

case "$cmd" in
    whoami)
        bot_api GET getMe
        echo "$BOT_RESP" | jq -c '.result | {id, is_bot, first_name, username}'
        ;;

    send)
        chat_id="${1:-}"
        shift || true
        message="$*"
        [[ -n "$chat_id" ]] && [[ -n "$message" ]] || err "usage: send <chat-id> <message>"
        payload=$(jq -nc --arg cid "$chat_id" --arg text "$message" '{chat_id: $cid, text: $text}')
        bot_api POST sendMessage -H "Content-Type: application/json" -d "$payload"
        echo "$BOT_RESP" | jq -c '.result | {message_id, chat_id: .chat.id}'
        ;;

    sendVoice|send-voice)
        chat_id="${1:-}"
        voice_file="${2:-}"
        [[ -n "$chat_id" ]] && [[ -n "$voice_file" ]] || err "usage: sendVoice <chat-id> <voice-file>"
        [[ -f "$voice_file" ]] || err "file not found: $voice_file"
        bot_api POST sendVoice -F "chat_id=$chat_id" -F "voice=@$voice_file"
        echo "$BOT_RESP" | jq -c '.result | {message_id, chat_id: .chat.id, duration: .voice.duration}'
        ;;

    poll)
        # Read current offset
        offset=0
        if [[ -n "$OFFSET_FILE" ]] && [[ -f "$OFFSET_FILE" ]]; then
            offset=$(cat "$OFFSET_FILE" 2>/dev/null | tr -d '[:space:]')
            [[ -n "$offset" ]] || offset=0
        fi

        qparams="offset=${offset}&timeout=0"
        bot_api GET "getUpdates?${qparams}"
        resp="$BOT_RESP"

        count=$(echo "$resp" | jq '.result | length' 2>/dev/null) || count=0
        [[ "$count" -gt 0 ]] 2>/dev/null || exit 1

        max_id=$offset
        wrote=0
        while IFS= read -r update; do
            [[ -z "$update" ]] && continue
            # Filter: messages with any content (skip edits, callbacks, etc.)
            has_content=$(echo "$update" | jq -r 'select(.message.text // .message.voice // .message.photo // .message.document // .message.video // .message.audio // .message.sticker) | .update_id' 2>/dev/null)
            [[ -z "$has_content" ]] && continue

            # Gate: skip messages from users not in TELEGRAM_ALLOWED_IDS
            if [[ -n "$ALLOWED" ]]; then
                from_id=$(echo "$update" | jq -r '.message.from.id' 2>/dev/null)
                [[ ",$ALLOWED," == *",$from_id,"* ]] || continue
            fi

            # Build reply_to context if this message is a reply
            reply_to=$(echo "$update" | jq -c '
                .message.reply_to_message // empty |
                {
                    from: (.from.username // .from.first_name // "unknown"),
                    text: (.text // null),
                    date: .date
                }' 2>/dev/null) || true

            # Detect message type and extract attachment info
            # Priority: voice > photo > document > video > audio > sticker > text
            echo "$update" | jq -c --argjson reply "${reply_to:-null}" '
                .message as $m |
                {
                    update_id: .update_id,
                    chat_id: $m.chat.id,
                    from: ($m.from.username // $m.from.first_name // "unknown"),
                    date: $m.date,
                    text: ($m.text // $m.caption // null)
                } +
                if $m.voice then
                    {type: "voice", file_id: $m.voice.file_id, duration: $m.voice.duration}
                elif $m.photo then
                    {type: "photo", file_id: ($m.photo | last | .file_id), file_size: ($m.photo | last | .file_size)}
                elif $m.document then
                    {type: "document", file_id: $m.document.file_id, filename: ($m.document.file_name // null), mime_type: ($m.document.mime_type // null), file_size: ($m.document.file_size // null)}
                elif $m.video then
                    {type: "video", file_id: $m.video.file_id, duration: $m.video.duration, file_size: ($m.video.file_size // null)}
                elif $m.audio then
                    {type: "audio", file_id: $m.audio.file_id, duration: $m.audio.duration, filename: ($m.audio.file_name // null)}
                elif $m.sticker then
                    {type: "sticker", file_id: $m.sticker.file_id, emoji: ($m.sticker.emoji // null)}
                else
                    {type: "text"}
                end +
                if $reply then {reply_to: $reply} else {} end
            '
            wrote=1

            uid=$(echo "$update" | jq '.update_id' 2>/dev/null)
            [[ "$uid" -gt "$max_id" ]] 2>/dev/null && max_id=$uid
        done < <(echo "$resp" | jq -c '.result[]' 2>/dev/null)

        # Update offset to max_id + 1 (getUpdates offset = last confirmed + 1)
        if [[ "$max_id" -gt 0 ]] 2>/dev/null; then
            new_offset=$((max_id + 1))
            if [[ -n "$OFFSET_FILE" ]]; then
                echo "$new_offset" > "$OFFSET_FILE"
            fi
        fi

        [[ "$wrote" == "1" ]] || exit 1
        ;;

    download)
        file_id="${1:-}"
        output_dir="${2:-.}"
        [[ -n "$file_id" ]] || err "usage: download <file-id> [output-dir]"
        [[ -d "$output_dir" ]] || err "directory not found: $output_dir"

        # Step 1: getFile — returns file_path on Telegram's servers
        bot_api GET "getFile?file_id=${file_id}"
        file_path=$(echo "$BOT_RESP" | jq -r '.result.file_path // empty')
        [[ -n "$file_path" ]] || err "no file_path returned for file_id: $file_id"

        # Step 2: download from Telegram CDN
        filename=$(basename "$file_path")
        output_file="$output_dir/$filename"
        local_status=$(curl -s -o "$output_file" -w '%{http_code}' --max-time 30 \
            "${API_BASE}/file/bot${TOKEN}/${file_path}" 2>/dev/null) || err "download failed"
        [[ "$local_status" -ge 200 ]] && [[ "$local_status" -lt 300 ]] 2>/dev/null || {
            rm -f "$output_file"
            err "download failed: HTTP $local_status"
        }

        file_size=$(wc -c < "$output_file" | tr -d ' ')
        jq -nc --arg path "$output_file" --arg size "$file_size" --arg name "$filename" \
            '{path: $path, filename: $name, size: ($size | tonumber)}'
        ;;

    help|--help|-h|*)
        jq -nc '{
            commands: {
                whoami: "whoami — verify bot token (getMe)",
                send: "send <chat-id> <message> — send message to chat",
                sendVoice: "sendVoice <chat-id> <voice-file> — send voice message (OGG/Opus)",
                poll: "poll — get new DMs: text, voice, photo, document, video, audio, sticker",
                download: "download <file-id> [dir] — download attachment by file_id"
            },
            flags: ["--token <bot-token>", "--api-base <url>"],
            notes: "Without --token, must be called via: sudo -u fagents telegram.sh"
        }'
        ;;
esac
