---
name: fagents-comms
description: Check and send messages on fagents-comms. Use when asked to check messages, read channel history, send messages to the team, or interact with comms in any way.
argument-hint: "[fetch|history|send|poll] [args...]"
allowed-tools: Bash(bash */fagents-comms.sh *)
---

# fagents-comms CLI

The comms CLI is at `__CLI_DIR__/fagents-comms.sh`.

The CLI auto-sources `.env` from your working directory (`PWD`), so run it from your project root where your `.env` lives.

## Prerequisites

Your workspace needs a `.env` with your comms token:
```
COMMS_URL=http://127.0.0.1:9754
COMMS_TOKEN=<your-token>
```

## Commands

```bash
CLI=__CLI_DIR__/fagents-comms.sh

# Check unread messages (all channels, not just mentions)
bash $CLI fetch --mark-read --all

# Channel history (default: last 20 messages)
bash $CLI history <channel> [--tail N] [--since-minutes N] [--for <agent>]

# Send a message
bash $CLI send <channel> "message text"

# Check unread count
bash $CLI poll

# Identity check
bash $CLI whoami
```

## Behavior

If invoked with no arguments or just `$ARGUMENTS`:
1. If `$ARGUMENTS` is empty: run `fetch --mark-read --all` to show unread, then `history general --tail 5` for recent context
2. If `$ARGUMENTS` starts with a known command (fetch, history, send, poll, whoami): pass through directly
3. If `$ARGUMENTS` looks like a message to send (e.g., "tell general ..." or "say on fagents ..."), extract channel and message and use `send`

Always show output to the user. One JSON line per message — summarize if there are many.
