---
name: cron
description: Schedule recurring tasks that wake you on a schedule via your inbox queue.
argument-hint: "[add|list|remove] [args...]"
allowed-tools: Bash(bash __AUTONOMY_DIR__/cron.sh *)
---

# Recurring Tasks (cron)

Schedule messages to your own inbox on a recurring basis. When a cron fires, a message lands in your `.queue/inbox/` and the daemon wakes you on a normal msgbeat. You see the message in your inbox like any other — the body tells you what to do.

**Use this when:** you want to do something on a schedule — review memory weekly, check comms every few hours, run a health check daily, post a standup summary on weekday mornings.

## Commands

```bash
CRON=__AUTONOMY_DIR__/cron.sh

# Add a recurring task
bash $CRON add <handle> "<schedule>" "<message>"

# List all recurring tasks
bash $CRON list

# Remove a recurring task
bash $CRON remove <handle>
```

**Handle** is a short kebab-case name you choose: `weekly-review`, `daily-health`, `standup-reminder`. Used to identify the task for listing and removal.

**Message** is the text you'll see in your inbox when the cron fires. Write it as an instruction to your future self.

## Cron schedule syntax

Five fields: `minute hour day-of-month month day-of-week`

```
┌───────── minute (0-59)
│ ┌─────── hour (0-23)
│ │ ┌───── day of month (1-31)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-6, 0=Sunday)
│ │ │ │ │
* * * * *
```

### Common patterns

| Schedule | Cron expression | Meaning |
|----------|----------------|---------|
| Every 6 hours | `0 */6 * * *` | At minute 0 of every 6th hour |
| Daily at 9am | `0 9 * * *` | 9:00 every day |
| Weekdays at 9am | `0 9 * * 1-5` | 9:00 Monday through Friday |
| Every Monday at 9am | `0 9 * * 1` | 9:00 every Monday |
| Twice a day (9am, 6pm) | `0 9,18 * * *` | 9:00 and 18:00 every day |
| Every 30 minutes | `*/30 * * * *` | At minute 0 and 30 of every hour |
| First of month at noon | `0 12 1 * *` | 12:00 on the 1st of each month |
| Every 4 hours during work | `0 8,12,16,20 * * *` | At 8, 12, 16, 20 every day |

**Note:** Times are in the system's local timezone.

### Special characters

- `*` — every value (every minute, every hour, etc.)
- `*/N` — every Nth value (`*/6` in the hour field = every 6 hours)
- `N,M` — specific values (`9,18` = at 9 and 18)
- `N-M` — range (`1-5` in day-of-week = Monday through Friday)

## Examples

```bash
CRON=__AUTONOMY_DIR__/cron.sh

# Weekly memory review — Monday mornings
bash $CRON add weekly-review "0 9 * * 1" "Time for your weekly memory review. Read MEMORY.md with fresh eyes, archive old entries, consolidate."

# Check comms every 4 hours during the day
bash $CRON add comms-check "0 8,12,16,20 * * *" "Periodic comms check. Read channels, respond to anything waiting."

# Daily standup summary on weekdays
bash $CRON add standup "0 9 * * 1-5" "Post your standup to #general: what you did yesterday, what you're doing today, any blockers."

# Monthly infrastructure review
bash $CRON add infra-review "0 10 1 * *" "Monthly infra review. Check disk, services, logs, certs. Post findings to #ops."

# See what's scheduled
bash $CRON list

# Remove one
bash $CRON remove comms-check
```

## How it works

1. `cron.sh add` writes an entry to your user's crontab
2. At the scheduled time, system cron runs `cron.sh fire` which drops a `.jsonl` message into `.queue/inbox/`
3. The daemon's `collect_and_wait` sees the file and wakes you on a msgbeat
4. You see the message in your inbox: `[cron:weekly-review] Time for your weekly memory review...`
5. Do the thing. The cron fires again next time.

Cron entries are tagged with `fagents-cron:<handle>` so `list` and `remove` only touch fagents entries — your other crontab entries are safe.
