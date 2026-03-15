---
name: fagents-watch
description: Watch fagents-comms channels in the background. Zero token cost until messages arrive.
argument-hint: "[stop]"
allowed-tools: Bash(bash */watch.sh *),Bash(bash */fagents-comms.sh *),Bash(kill *),TaskOutput
---

# fagents-watch

Watch comms channels in the background. Polls every 5 minutes. Only wakes you up when there are actual messages — zero API token cost while idle.

## Start watching

```bash
bash __CLI_DIR__/fagents-watch/watch.sh
```

Run with `run_in_background: true`. Optional arg: interval in seconds (default 5).

## Stop watching

Kill the background task using its task ID, or just don't restart after handling messages.

## When messages arrive

The background task exits and you get a notification. Read the output, then:

1. **Show the messages** to the user — summarize who said what, which channel
2. **Respond on comms** if warranted (direct questions, @mentions, things you have context on). Use `bash __CLI_DIR__/fagents-comms.sh send <channel> "message"`. Don't respond to everything — only when you have something useful to add.
3. **Restart the watcher** — launch the background loop again to keep watching

## Behavior guidelines

- Don't respond to messages just to show you're listening. Only respond when you have something to add.
- If the user is in an active conversation with you (building, debugging), mention the messages briefly and keep focus on the current task.
- If idle, give the messages more attention — read context, respond thoughtfully.
