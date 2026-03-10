#!/usr/bin/env bash
# x.sh — agent-first X (Twitter) API v2 client
# All output is JSON. Agents are the users.
#
# Credential loading:
#   --bearer-token / --consumer-key etc. flags for testing/manual use
#   Otherwise, must be called via: sudo -u fagents x.sh <command>
#   Resolves caller from $SUDO_USER, loads creds from /home/fagents/.agents/<caller>/
#
# Commands:
#   x.sh search <query> [--count N]              — search recent tweets
#   x.sh tweet <tweet-id>                        — get a single tweet
#   x.sh user <username>                         — get user by username
#   x.sh tweets <username> [--count N]           — get user's recent tweets
#   x.sh post <text>                             — post a tweet
#   x.sh reply <tweet-id> <text>                 — reply to a tweet

set -euo pipefail

API_BASE="https://api.twitter.com"
CREDS_DIR="/home/fagents/.agents"
BEARER_TOKEN=""
CONSUMER_KEY=""
CONSUMER_SECRET=""
ACCESS_TOKEN=""
ACCESS_TOKEN_SECRET=""

TWEET_FIELDS="created_at,public_metrics,author_id,conversation_id,lang"
USER_FIELDS="created_at,description,public_metrics,profile_image_url,verified,location"

err() {
    jq -nc --arg msg "$1" '{error: $msg}'
    exit 1
}

# Parse global flags before command
while [[ "${1:-}" == --* ]]; do
    case "$1" in
        --bearer-token)         BEARER_TOKEN="$2"; shift 2 ;;
        --consumer-key)         CONSUMER_KEY="$2"; shift 2 ;;
        --consumer-secret)      CONSUMER_SECRET="$2"; shift 2 ;;
        --access-token)         ACCESS_TOKEN="$2"; shift 2 ;;
        --access-token-secret)  ACCESS_TOKEN_SECRET="$2"; shift 2 ;;
        --api-base)             API_BASE="$2"; shift 2 ;;
        *) break ;;
    esac
done

# Resolve credentials from env file if no flags provided
CALLER="${SUDO_USER:-}"
if [[ -z "$BEARER_TOKEN" && -z "$CONSUMER_KEY" ]]; then
    [[ -z "$CALLER" ]] && err "Must be called via sudo -u fagents (or use --bearer-token / --consumer-key)"
    CRED_FILE="$CREDS_DIR/$CALLER/x.env"
    [[ -f "$CRED_FILE" ]] || err "No X credentials for $CALLER"
    source "$CRED_FILE"
    BEARER_TOKEN="${X_BEARER_TOKEN:-}"
    CONSUMER_KEY="${X_CONSUMER_KEY:-}"
    CONSUMER_SECRET="${X_CONSUMER_SECRET:-}"
    ACCESS_TOKEN="${X_ACCESS_TOKEN:-}"
    ACCESS_TOKEN_SECRET="${X_ACCESS_TOKEN_SECRET:-}"
fi

# HTTP helper — calls API, outputs JSON, exits 1 on error
_api() {
    local tmpfile
    tmpfile=$(mktemp)
    local http_code
    http_code=$(curl -s -o "$tmpfile" -w '%{http_code}' --max-time 10 "$@") || {
        rm -f "$tmpfile"; err "network error"
    }
    cat "$tmpfile"
    rm -f "$tmpfile"
    [ "${http_code}" -ge 400 ] 2>/dev/null && exit 1
    return 0
}

# Percent-encode (RFC 3986)
_pct_encode() {
    printf '%s' "$1" | jq -sRr @uri
}

# OAuth 1.0a signature for POST requests (JSON body NOT included in signature)
_oauth_header() {
    local method="$1" url="$2"
    local nonce timestamp
    nonce=$(openssl rand -hex 16)
    timestamp=$(date +%s)

    # OAuth params
    local -a params=(
        "oauth_consumer_key=$CONSUMER_KEY"
        "oauth_nonce=$nonce"
        "oauth_signature_method=HMAC-SHA1"
        "oauth_timestamp=$timestamp"
        "oauth_token=$ACCESS_TOKEN"
        "oauth_version=1.0"
    )

    # Sort and build param string
    local param_string
    param_string=$(printf '%s\n' "${params[@]}" | sort | paste -sd '&' -)

    # Signature base string
    local base_string
    base_string="${method}&$(_pct_encode "$url")&$(_pct_encode "$param_string")"

    # Signing key
    local signing_key
    signing_key="$(_pct_encode "$CONSUMER_SECRET")&$(_pct_encode "$ACCESS_TOKEN_SECRET")"

    # HMAC-SHA1
    local signature
    signature=$(printf '%s' "$base_string" | openssl dgst -sha1 -hmac "$signing_key" -binary | base64)

    # Build header
    printf 'OAuth oauth_consumer_key="%s", oauth_nonce="%s", oauth_signature="%s", oauth_signature_method="HMAC-SHA1", oauth_timestamp="%s", oauth_token="%s", oauth_version="1.0"' \
        "$(_pct_encode "$CONSUMER_KEY")" \
        "$(_pct_encode "$nonce")" \
        "$(_pct_encode "$signature")" \
        "$timestamp" \
        "$(_pct_encode "$ACCESS_TOKEN")"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
    search)
        [[ -n "$BEARER_TOKEN" ]] || err "Bearer token required for search"
        query="${1:-}"
        [[ -n "$query" ]] || err "usage: search <query> [--count N]"
        shift || true
        count=10
        while [[ "${1:-}" == --* ]]; do
            case "$1" in
                --count) count="$2"; shift 2 ;;
                *) break ;;
            esac
        done
        _api -H "Authorization: Bearer $BEARER_TOKEN" \
            "${API_BASE}/2/tweets/search/recent?query=$(_pct_encode "$query")&max_results=${count}&tweet.fields=${TWEET_FIELDS}"
        ;;

    tweet)
        [[ -n "$BEARER_TOKEN" ]] || err "Bearer token required for tweet lookup"
        tweet_id="${1:-}"
        [[ -n "$tweet_id" ]] || err "usage: tweet <tweet-id>"
        _api -H "Authorization: Bearer $BEARER_TOKEN" \
            "${API_BASE}/2/tweets/${tweet_id}?tweet.fields=${TWEET_FIELDS}"
        ;;

    user)
        [[ -n "$BEARER_TOKEN" ]] || err "Bearer token required for user lookup"
        username="${1:-}"
        [[ -n "$username" ]] || err "usage: user <username>"
        # Strip @ prefix if present
        username="${username#@}"
        _api -H "Authorization: Bearer $BEARER_TOKEN" \
            "${API_BASE}/2/users/by/username/${username}?user.fields=${USER_FIELDS}"
        ;;

    tweets)
        [[ -n "$BEARER_TOKEN" ]] || err "Bearer token required for tweets lookup"
        username="${1:-}"
        [[ -n "$username" ]] || err "usage: tweets <username> [--count N]"
        username="${username#@}"
        shift || true
        count=10
        while [[ "${1:-}" == --* ]]; do
            case "$1" in
                --count) count="$2"; shift 2 ;;
                *) break ;;
            esac
        done
        # Resolve user ID first
        user_resp=$(_api -H "Authorization: Bearer $BEARER_TOKEN" \
            "${API_BASE}/2/users/by/username/${username}?user.fields=id")
        user_id=$(echo "$user_resp" | jq -r '.data.id // empty' 2>/dev/null)
        [[ -n "$user_id" ]] || err "User not found: $username"
        # Fetch tweets
        _api -H "Authorization: Bearer $BEARER_TOKEN" \
            "${API_BASE}/2/users/${user_id}/tweets?max_results=${count}&tweet.fields=${TWEET_FIELDS}"
        ;;

    post)
        [[ -n "$CONSUMER_KEY" && -n "$CONSUMER_SECRET" && -n "$ACCESS_TOKEN" && -n "$ACCESS_TOKEN_SECRET" ]] || \
            err "OAuth credentials required for post (consumer key/secret + access token/secret)"
        text="$*"
        [[ -n "$text" ]] || err "usage: post <text>"
        url="${API_BASE}/2/tweets"
        auth_header=$(_oauth_header "POST" "$url")
        payload=$(jq -nc --arg text "$text" '{text: $text}')
        _api -X POST -H "Authorization: $auth_header" \
            -H "Content-Type: application/json" \
            -d "$payload" "$url"
        ;;

    reply)
        [[ -n "$CONSUMER_KEY" && -n "$CONSUMER_SECRET" && -n "$ACCESS_TOKEN" && -n "$ACCESS_TOKEN_SECRET" ]] || \
            err "OAuth credentials required for reply (consumer key/secret + access token/secret)"
        tweet_id="${1:-}"
        shift || true
        text="$*"
        [[ -n "$tweet_id" && -n "$text" ]] || err "usage: reply <tweet-id> <text>"
        url="${API_BASE}/2/tweets"
        auth_header=$(_oauth_header "POST" "$url")
        payload=$(jq -nc --arg text "$text" --arg rid "$tweet_id" '{text: $text, reply: {in_reply_to_tweet_id: $rid}}')
        _api -X POST -H "Authorization: $auth_header" \
            -H "Content-Type: application/json" \
            -d "$payload" "$url"
        ;;

    help|--help|-h|*)
        jq -nc '{
            commands: {
                search: "search <query> [--count N] — search recent tweets",
                tweet: "tweet <tweet-id> — get a single tweet",
                user: "user <username> — get user by username",
                tweets: "tweets <username> [--count N] — get user recent tweets",
                post: "post <text> — post a tweet (OAuth required)",
                reply: "reply <tweet-id> <text> — reply to a tweet (OAuth required)"
            },
            flags: ["--bearer-token <token>", "--consumer-key <key>", "--consumer-secret <secret>", "--access-token <token>", "--access-token-secret <secret>", "--api-base <url>"],
            notes: "Without flags, must be called via: sudo -u fagents x.sh"
        }'
        ;;
esac
