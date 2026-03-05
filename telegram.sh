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
#   telegram.sh whoami                    — verify bot token (getMe)
#   telegram.sh send <chat-id> <message>  — send message to chat
#   telegram.sh poll                      — get new DMs (one JSON line per message)

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
            # Filter: only message updates with text (skip edits, callbacks, etc.)
            has_text=$(echo "$update" | jq -r 'select(.message.text) | .update_id' 2>/dev/null)
            [[ -z "$has_text" ]] && continue

            echo "$update" | jq -c '{
                update_id: .update_id,
                chat_id: .message.chat.id,
                from: (.message.from.username // .message.from.first_name // "unknown"),
                text: .message.text,
                date: .message.date
            }'
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

    help|--help|-h|*)
        jq -nc '{
            commands: {
                whoami: "whoami — verify bot token (getMe)",
                send: "send <chat-id> <message> — send message to chat",
                poll: "poll — get new DMs (one JSON line per message)"
            },
            flags: ["--token <bot-token>", "--api-base <url>"],
            notes: "Without --token, must be called via: sudo -u fagents telegram.sh"
        }'
        ;;
esac
