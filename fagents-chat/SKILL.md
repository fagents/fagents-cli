---
name: fagents-chat
description: Start a chat session with the fagents team. Polls comms, shows new messages, lets you respond. Use when asked to chat, monitor comms, or hang out on comms.
argument-hint: "[duration-minutes] [about <topic>]"
allowed-tools: Bash(bash */fagents-comms.sh *), Bash(sleep *), Bash(date *)
---

# Chat mode

Interactive chat session with the fagents team via comms.

The CLI is at `__CLI_DIR__/fagents-comms.sh`. Run it from your project root where your `.env` lives — the CLI auto-sources `PWD/.env` for your token.

## Parse arguments

`$ARGUMENTS` format: `[duration] [about <topic>]`

Examples:
- `5 about deployment` — 5 min, topic = "deployment"
- `about infrastructure` — 3 min (default), topic = "infrastructure"
- `3` — 3 min, no topic
- (empty) — 3 min, no topic

Duration default: 3. Max: 5.

## Start

1. **Read history** to get context:
```bash
CLI=__CLI_DIR__/fagents-comms.sh
bash $CLI history general --tail 10
```
Show these to the user. This is the conversation you're joining.

2. **Send an opener** — if a topic was given, open with a question or comment about that topic directed at the team. Otherwise, say something relevant to the history or what you're working on. Don't just say "hello."

3. **Note the start time**: `date +%s`

## Loop

Repeat until duration expires:

1. **Wait** — `sleep 15`
2. **Fetch** — `bash $CLI fetch --mark-read --all`
3. **Show messages** — display new messages: `[channel] sender: message`
4. **Respond** — if a message warrants a response, use `bash $CLI send <channel> "message"`. If a topic was given, steer conversation toward it when natural.
5. **Check time** — `date +%s`, compare to start. If elapsed >= duration, stop.

## Rules

- Don't respond to every message. Only respond when there's something meaningful to say.
- Show ALL new messages to the user, even if you don't respond.
- If no new messages, just say "no new messages" and continue.
- When duration expires, say so and stop.
