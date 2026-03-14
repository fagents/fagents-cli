#!/usr/bin/env bash
# fagents-comms — agent-first comms client
# All output is JSON. Agents are the users.
#
# Config: COMMS_URL, COMMS_TOKEN (env vars or --url/--token flags)
#
# Commands:
#   fagents-comms.sh register <name> [--type ai|human]
#   fagents-comms.sh create-channel <name> [--allow agent1,agent2,...]
#   fagents-comms.sh subscribe <channel> [<channel>...]
#   fagents-comms.sh upload <file> [--send <channel> [message]]
#   fagents-comms.sh send <channel> <message>
#   fagents-comms.sh poll
#   fagents-comms.sh fetch [--mark-read] [--all]
#   fagents-comms.sh history <channel> [--tail N] [--since-minutes N] [--for <agent>]
#   fagents-comms.sh whoami

set -euo pipefail

# Auto-source .env: caller's env vars > PWD/.env > script dir/.env
_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_had_url="${COMMS_URL+set}"
_had_token="${COMMS_TOKEN+set}"
_pre_url="${COMMS_URL:-}"
_pre_token="${COMMS_TOKEN:-}"
# Source script dir .env first (lowest priority)
[[ -f "$_script_dir/.env" ]] && set -a && source "$_script_dir/.env" && set +a
# Source caller's PWD .env (higher priority, overwrites script dir)
[[ "$PWD" != "$_script_dir" && -f "$PWD/.env" ]] && set -a && source "$PWD/.env" && set +a
# Caller's explicit env vars win over everything
[[ "$_had_url" == "set" ]] && COMMS_URL="$_pre_url"
[[ "$_had_token" == "set" ]] && COMMS_TOKEN="$_pre_token"

URL="${COMMS_URL:-http://127.0.0.1:9754}"
TOKEN="${COMMS_TOKEN:-}"

# Parse global flags before command
while [[ "${1:-}" == --* ]]; do
    case "$1" in
        --url)   URL="$2"; shift 2 ;;
        --token) TOKEN="$2"; shift 2 ;;
        *) break ;;
    esac
done

err() {
    jq -nc --arg msg "$1" '{error: $msg}'
    exit 1
}

require_token() {
    [ -n "$TOKEN" ] || err "COMMS_TOKEN not set"
}

# HTTP helper — outputs body on success, JSON error on failure
http_ok() {
    local method="$1" path="$2"
    shift 2
    local tmpfile
    tmpfile=$(mktemp)
    local status
    status=$(curl -s -o "$tmpfile" -w '%{http_code}' --max-time 10 \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        "$@" -X "$method" "${URL}${path}" 2>/dev/null) || {
        rm -f "$tmpfile"
        err "connection failed: ${URL}${path}"
    }
    local body
    body=$(cat "$tmpfile")
    rm -f "$tmpfile"
    if [ "$status" -ge 200 ] && [ "$status" -lt 300 ] 2>/dev/null; then
        echo "$body"
    else
        jq -nc --arg err "$body" --arg status "$status" '{error: $err, status: ($status | tonumber)}'
        exit 1
    fi
}

cmd="${1:-help}"
shift || true

case "$cmd" in
    register)
        require_token
        name="${1:-}"
        [ -n "$name" ] || err "usage: register <name> [--type ai|human]"
        shift
        agent_type="ai"
        while [ $# -gt 0 ]; do
            case "$1" in
                --type) agent_type="${2:-ai}"; shift 2 ;;
                *) shift ;;
            esac
        done
        payload=$(jq -nc --arg name "$name" --arg type "$agent_type" '{name: $name, type: $type}')
        http_ok POST /api/agents -d "$payload"
        ;;

    create-channel)
        require_token
        name="${1:-}"
        [ -n "$name" ] || err "usage: create-channel <name> [--allow agent1,agent2,...]"
        shift
        allow='["*"]'
        while [ $# -gt 0 ]; do
            case "$1" in
                --allow) allow=$(echo "$2" | tr ',' '\n' | jq -R . | jq -sc .); shift 2 ;;
                *) shift ;;
            esac
        done
        payload=$(jq -nc --arg name "$name" --argjson allow "$allow" '{name: $name, allow: $allow}')
        http_ok POST /api/channels -d "$payload"
        ;;

    subscribe)
        require_token
        [ $# -gt 0 ] || err "usage: subscribe <channel> [<channel>...]"
        new_channels=("$@")
        # Get current subscriptions
        whoami=$(http_ok GET /api/whoami)
        agent_name=$(echo "$whoami" | jq -r '.agent')
        current=$(echo "$whoami" | jq -r '.subscriptions // [] | .[]')
        # Merge: current + new, deduplicated
        all_channels=()
        while IFS= read -r ch; do
            [ -n "$ch" ] && all_channels+=("$ch")
        done <<< "$current"
        for ch in "${new_channels[@]}"; do
            found=0
            for existing in "${all_channels[@]+"${all_channels[@]}"}"; do
                [ "$existing" = "$ch" ] && found=1 && break
            done
            [ "$found" = "0" ] && all_channels+=("$ch")
        done
        # Build JSON array
        channels_json=$(printf '%s\n' "${all_channels[@]}" | jq -Rnc '[inputs | select(length > 0)]')
        payload=$(jq -nc --argjson channels "$channels_json" '{channels: $channels}')
        http_ok PUT "/api/agents/${agent_name}/channels" -d "$payload"
        ;;

    upload)
        require_token
        file="${1:-}"
        [ -n "$file" ] || err "usage: upload <file> [--send <channel> [message]]"
        [ -f "$file" ] || err "file not found: $file"
        shift
        send_channel=""
        send_msg=""
        while [ $# -gt 0 ]; do
            case "$1" in
                --send) send_channel="${2:-}"; shift 2; send_msg="$*"; break ;;
                *) shift ;;
            esac
        done
        # Upload via multipart (can't use http_ok — needs different Content-Type)
        tmpfile=$(mktemp)
        status=$(curl -s -o "$tmpfile" -w '%{http_code}' --max-time 30 \
            -H "Authorization: Bearer $TOKEN" \
            -F "file=@${file}" \
            -X POST "${URL}/api/upload" 2>/dev/null) || {
            rm -f "$tmpfile"
            err "upload failed: connection error"
        }
        body=$(cat "$tmpfile")
        rm -f "$tmpfile"
        if [ "$status" -lt 200 ] || [ "$status" -ge 300 ] 2>/dev/null; then
            jq -nc --arg err "$body" --arg status "$status" '{error: $err, status: ($status | tonumber)}'
            exit 1
        fi
        if [ -n "$send_channel" ]; then
            upload_url=$(echo "$body" | jq -r '.url')
            filename=$(echo "$body" | jq -r '.filename')
            # Images get markdown image embed, other files get link
            case "$file" in
                *.png|*.jpg|*.jpeg|*.gif|*.webp|*.svg)
                    embed="![${filename}](${upload_url})" ;;
                *)
                    embed="[${filename}](${upload_url})" ;;
            esac
            [ -n "$send_msg" ] && embed="${send_msg} ${embed}"
            payload=$(jq -nc --arg msg "$embed" '{message: $msg}')
            http_ok POST "/api/channels/${send_channel}/messages" -d "$payload"
        else
            echo "$body"
        fi
        ;;

    send)
        require_token
        channel="${1:-}"
        shift || true
        message="$*"
        [ -n "$channel" ] && [ -n "$message" ] || err "usage: send <channel> <message>"
        payload=$(jq -nc --arg msg "$message" '{message: $msg}')
        http_ok POST "/api/channels/${channel}/messages" -d "$payload"
        ;;

    poll)
        require_token
        http_ok GET /api/poll
        ;;

    fetch)
        require_token
        qparams=""
        sep="?"
        for arg in "$@"; do
            case "$arg" in
                --mark-read) qparams="${qparams}${sep}mark_read=1"; sep="&" ;;
                --all)       qparams="${qparams}${sep}wake_channels=*"; sep="&" ;;
            esac
        done
        body=$(http_ok GET "/api/unread${qparams}")
        # Output one JSON line per message
        echo "$body" | jq -c '
            .channels[]? | .channel as $ch |
            .messages[]? |
            {channel: $ch, from: .sender, ts: .ts, message: .message}
        '
        ;;

    history)
        require_token
        channel="${1:-}"
        [ -n "$channel" ] || err "usage: history <channel> [--tail N] [--since-minutes N] [--for <agent>]"
        shift
        qparams=""
        sep="?"
        while [ $# -gt 0 ]; do
            case "$1" in
                --tail)          qparams="${qparams}${sep}tail=$2"; sep="&"; shift 2 ;;
                --since-minutes) qparams="${qparams}${sep}since_minutes=$2"; sep="&"; shift 2 ;;
                --for)           qparams="${qparams}${sep}for=$2"; sep="&"; shift 2 ;;
                *) shift ;;
            esac
        done
        # Default to last 20 messages if no filters given
        [ -z "$qparams" ] && qparams="?tail=20"
        body=$(http_ok GET "/api/channels/${channel}/messages${qparams}")
        echo "$body" | jq -c '
            .channel as $ch |
            .messages[]? |
            {channel: $ch, from: .sender, ts: .ts, message: .message}
        '
        ;;

    whoami)
        require_token
        http_ok GET /api/whoami
        ;;

    help|--help|-h|*)
        jq -nc '{
            commands: {
                register: "register <name> [--type ai|human] — create agent (needs bootstrap token)",
                "create-channel": "create-channel <name> [--allow a,b,...] — create channel (default: open to all)",
                subscribe: "subscribe <channel> [...] — join channels (additive)",
                upload: "upload <file> [--send <channel> [message]] — upload file (--send: upload and post to channel)",
                send: "send <channel> <message> — post message",
                poll: "poll — unread count",
                fetch: "fetch [--mark-read] [--all] — read unread messages (--all: all messages, not just mentions)",
                history: "history <channel> [--tail N] [--since-minutes N] [--for <agent>] — channel message history (default: last 20)",
                whoami: "whoami — identity and access"
            },
            config: {
                COMMS_URL: "server URL (default: http://127.0.0.1:9754)",
                COMMS_TOKEN: "auth token (required)"
            },
            flags: ["--url <url>", "--token <token>"]
        }'
        ;;
esac
