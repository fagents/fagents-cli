---
name: telegram
description: Send and receive Telegram messages (text, voice, photos, documents) via Bot API.
argument-hint: "[send|sendVoice|poll|download|whoami] [args...]"
allowed-tools: Bash(sudo -u fagents */telegram.sh *),Bash(sudo -u fagents */tts-speak.sh *),Bash(sudo -u fagents */stt-transcribe.sh *)
---

# Telegram

Send and receive Telegram messages via the Bot API. Supports DMs, group chats, text, and voice.

## Usage

All commands go through sudo — you never see the bot token or API keys:

```bash
CLI=/home/fagents/workspace/fagents-cli
sudo -u fagents $CLI/telegram.sh <command> [args...]
```

## Commands

### whoami
Verify your bot token works. Returns bot info.
```bash
sudo -u fagents $CLI/telegram.sh whoami
```

### send
Send a text message to a chat. Chat ID comes from a previous `poll` or is known.
```bash
sudo -u fagents $CLI/telegram.sh send <chat-id> "message text"
```

### sendVoice
Send an OGG/Opus audio file as a voice message.
```bash
sudo -u fagents $CLI/telegram.sh sendVoice <chat-id> <voice-file.ogg>
```

### poll
Check for new messages (DMs and group chats). Returns one JSON line per message, exits 1 if no new messages. Detects text, voice, photo, document, video, audio, and sticker messages.
```bash
sudo -u fagents $CLI/telegram.sh poll
```

Text: `{"type":"text", "text":"hello", ...}`
Photo: `{"type":"photo", "file_id":"...", "text":"caption or null", "file_size":50000, ...}`
Document: `{"type":"document", "file_id":"...", "filename":"report.pdf", "mime_type":"application/pdf", ...}`
Voice: `{"type":"voice", "file_id":"...", "duration":3, ...}`
Video/Audio/Sticker: similar, with `file_id` and type-specific fields.

### download
Download an attachment by `file_id` (from poll output). Returns path and size.
```bash
sudo -u fagents $CLI/telegram.sh download <file-id> [output-dir]
```
Output: `{"path":"./file_0.pdf", "filename":"file_0.pdf", "size":120000}`

Daemon agents: attachment messages arrive in the inbox with the download command pre-formatted — just run it.
Interactive agents: call `poll`, grab the `file_id`, then `download`.

## Voice

### Text to speech (reply with voice)
Converts text to speech via OpenAI TTS and sends as a Telegram voice message:
```bash
sudo -u fagents $CLI/tts-speak.sh <chat-id> "text to speak"
```
Options: `--voice <alloy|nova|shimmer|...>`, `--model <tts-1|tts-1-hd>`

### Speech to text (transcribe voice message)
Downloads a voice message from Telegram and transcribes via OpenAI Whisper:
```bash
sudo -u fagents $CLI/stt-transcribe.sh <file-id>
```
The `file_id` comes from poll output. Options: `--model <whisper-1>`, `--language <code>`

Daemon agents: `collect_telegram()` handles voice transcription automatically — incoming voice messages arrive in the inbox as text.
Interactive agents: call `poll` to check for messages, then `stt-transcribe.sh` for any voice messages.

Group chat_ids are negative integers (e.g. `-5277685086`). DM chat_ids are positive.

## Notes

- All output is JSON — parse with `jq`
- Offset tracking is automatic (handled by the CLI, not you)
- One bot per agent — `getUpdates` is destructive (consumes offsets)
- Daemon agents: `collect_telegram()` calls poll automatically. Interactive agents: call `poll` yourself, then `send` or `tts-speak.sh` to reply
- **Group chats**: bot must be added to the group AND BotFather privacy mode must be disabled (`/setprivacy` → select bot → Disable). With privacy mode ON (default), bots only receive @mentions and /commands in groups.
- **Replying**: use the `chat_id` from poll output to reply to the correct chat (DM or group)
- Do NOT try to access bot tokens or API keys directly — credential isolation via sudo
