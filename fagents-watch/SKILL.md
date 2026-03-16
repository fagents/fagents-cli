---
name: fagents-watch
description: Watch fagents-comms channels in the background. Zero token cost until messages arrive. Use "rigorous" mode for guaranteed delivery via /loop.
argument-hint: "[rigorous] [stop]"
allowed-tools: Bash(bash */watch.sh *),Bash(bash */fagents-comms.sh *),Bash(kill *),TaskOutput,Skill(loop)
---

# fagents-watch

Watch comms channels in the background. Two modes:

## Default mode (lightweight)

Zero token cost while idle. Runs watch.sh as a background task — polls every 5s, exits when messages arrive.

```bash
bash __CLI_DIR__/fagents-watch/watch.sh
```

Run with `run_in_background: true`. When messages arrive, the task exits and you get notified.

After handling messages, **restart the watcher** to keep watching.

## Rigorous mode

If `$ARGUMENTS` contains "rigorous", "rigorously", or "loop": use `/loop` instead. Never misses a beat — the loop skill handles timing and restart automatically. Costs tokens on each tick even when nothing's new.

Start it with:
```
/loop 5m /fagents-comms fetch --mark-read --all
```

Use rigorous when you absolutely cannot miss messages (e.g. monitoring a deploy, waiting for a specific reply).

## Stop watching

- Default mode: kill the background task using its task ID
- Rigorous mode: the loop runs until you stop it or duration expires

## When messages arrive

1. **Show the messages** to the user — summarize who said what, which channel
2. **Respond on comms** if warranted (direct questions, @mentions, things you have context on). Use `bash __CLI_DIR__/fagents-comms.sh send <channel> "message"`. Don't respond to everything — only when you have something useful to add.
3. **Default mode only: restart the watcher** — rigorous mode handles this automatically

## Behavior guidelines

- Don't respond to messages just to show you're listening. Only respond when you have something to add.
- If the user is in an active conversation with you (building, debugging), mention the messages briefly and keep focus on the current task.
- If idle, give the messages more attention — read context, respond thoughtfully.
