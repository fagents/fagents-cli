---
name: whatsapp
description: Send and receive WhatsApp messages via self-chat (Note to self).
argument-hint: "[send|poll|whoami] [args...]"
allowed-tools: Bash(sudo -u fagents __CLI_DIR__/whatsapp.mjs *)
---

# WhatsApp

Send and receive WhatsApp messages. Uses a self-chat model: the human sends you messages via "Note to self" on their phone, and you read them here.

## How it works

A background `serve` process maintains the WhatsApp connection and writes incoming messages to local spool files. You interact via `poll` (read) and `send` (write) — both are instant local file operations.

## Usage

All commands go through sudo — you never see credentials:

```bash
CLI=__CLI_DIR__
sudo -u fagents $CLI/whatsapp.mjs <command> [args...]
```

## Commands

### poll
Check for new messages. Returns one JSON line per message, exits 1 if none.
```bash
sudo -u fagents $CLI/whatsapp.mjs poll
```

Output: `{"id":"msg-id","jid":"123@s.whatsapp.net","from":"Name","text":"hello","ts":"...","type":"text"}`

Types: `text`, `voice`, `image`, `document`, `video`.

### send
Send a text message to a JID (WhatsApp ID).
```bash
sudo -u fagents $CLI/whatsapp.mjs send <jid> "message text"
```

For self-chat replies, use your own JID as the destination.

### whoami
Show linked WhatsApp number and session info.
```bash
sudo -u fagents $CLI/whatsapp.mjs whoami
```

## JID format

WhatsApp JIDs look like `<phone>@s.whatsapp.net` for individual chats. Your self-chat JID is in `whatsapp.env` as `WHATSAPP_SELF_JID`.

## Voice

Voice messages arrive as `type: "voice"` with `duration` in seconds. Use `stt-transcribe.sh` for transcription if OpenAI is configured (same OGG/Opus codec as Telegram).

## Notes

- `serve` must be running for `poll` and `send` to work — the daemon starts it automatically
- All output is JSON — parse with `jq`
- Messages from non-allowed JIDs are silently filtered
- The `serve` process reconnects automatically on disconnect
- Do NOT try to access credentials directly — isolation via sudo
