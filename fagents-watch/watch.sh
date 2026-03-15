#!/usr/bin/env bash
# watch.sh — poll fagents-comms, exit when messages arrive
# Designed to run in background. Zero cost while idle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$SCRIPT_DIR/../fagents-comms.sh"
INTERVAL="${1:-5}"

while true; do
    sleep "$INTERVAL"
    result=$(bash "$CLI" fetch --mark-read --all 2>/dev/null) || continue
    count=$(echo "$result" | jq -s 'length' 2>/dev/null) || continue
    if [ "${count:-0}" -gt 0 ]; then
        # Newest first — so truncated output still shows the latest messages
        echo "$result" | jq -s 'sort_by(.ts) | reverse | .[]' -c
        exit 0
    fi
done
