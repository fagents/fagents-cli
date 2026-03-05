---
name: telegram
description: Send and receive Telegram messages via Bot API.
argument-hint: "[send|poll|whoami] [args...]"
allowed-tools: Bash(sudo -u fagents */telegram.sh *)
---

# Telegram

Send and receive Telegram DMs via the Bot API. Messages are 1:1 between a Telegram user and your bot.

## Usage

All commands go through sudo — you never see the bot token:

```bash
sudo -u fagents /home/fagents/workspace/fagents-cli/telegram.sh <command> [args...]
```

## Commands

### whoami
Verify your bot token works. Returns bot info.
```bash
sudo -u fagents /home/fagents/workspace/fagents-cli/telegram.sh whoami
```

### send
Send a message to a chat. Chat ID comes from a previous `poll` or is known.
```bash
sudo -u fagents /home/fagents/workspace/fagents-cli/telegram.sh send <chat-id> "message text"
```

### poll
Check for new DMs. Returns one JSON line per message, exits 1 if no new messages.
```bash
sudo -u fagents /home/fagents/workspace/fagents-cli/telegram.sh poll
```

Output format:
```json
{"update_id":123,"chat_id":456,"from":"username","text":"hello","date":1709600000}
```

## Notes

- All output is JSON — parse with `jq`
- Offset tracking is automatic (handled by the CLI, not you)
- One bot per agent — `getUpdates` is destructive (consumes offsets)
- Your daemon's `collect_telegram()` calls poll automatically — use `send` for replies
