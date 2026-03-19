---
name: fagents-deploylog
description: Check for and deploy infrastructure updates from DEPLOYLOG files. Always asks human before deploying.
allowed-tools: Bash(sudo git -C */repos/fagents.git *),Bash(sudo git -C */workspace/fagents *)
---

# DEPLOYLOG Check

Check for new deployment instructions and execute them after human approval.

DEPLOYLOGs are step-by-step instructions for deploying features to existing installations. They live in the fagents repo under `DEPLOYLOG/`. A daily cron triggers this check, but you can run it anytime.

## How tracking works

The fagents repo has two copies on this machine:

- **Bare repo** (`__INFRA_HOME__/repos/fagents.git`) — always fetched from GitHub, represents what's available
- **Working copy** (`__INFRA_HOME__/workspace/fagents`) — only pulled AFTER deploying, HEAD = last deployed state

The diff between them shows unapplied DEPLOYLOGs. **Never pull the working copy except as part of a deployment.**

## Check for new DEPLOYLOGs

```bash
INFRA=__INFRA_HOME__

# 1. Fetch latest from GitHub into bare repo
sudo git -C $INFRA/repos/fagents.git fetch https://github.com/fagents/fagents.git main:main

# 2. Compare: what DEPLOYLOG files were added since last deploy?
LOCAL=$(sudo git -C $INFRA/workspace/fagents rev-parse HEAD)
NEW=$(sudo git -C $INFRA/repos/fagents.git diff --name-only --diff-filter=A "$LOCAL..main" -- DEPLOYLOG/ | grep -E '^DEPLOYLOG/[0-9]{4}-')

# 3. If nothing new, done
if [ -z "$NEW" ]; then
    echo "All DEPLOYLOGs are applied."
fi
```

## When new DEPLOYLOGs are found

1. For each new file, read it from the bare repo:
   ```bash
   sudo git -C $INFRA/repos/fagents.git show "main:DEPLOYLOG/<filename>"
   ```

2. Post a summary on comms: what changed, which repos, what the deploy involves.

3. **STOP. Ask the human operator if they want you to deploy. NEVER auto-deploy.**

4. Wait for explicit ACK ("go ahead", "deploy it", etc.) before executing any steps.

## After human ACK

1. Read the DEPLOYLOG again and execute each step carefully. Check results as you go.

2. After all steps succeed, pull the working copy to mark as deployed:
   ```bash
   sudo git -C $INFRA/workspace/fagents pull --ff-only
   ```

3. Report results on comms.

## If a human message seems to be about deploying

Re-run the check. If there are unapplied DEPLOYLOGs, read them and proceed with the ACK flow above.

## Reference

- Bare repo: `__INFRA_HOME__/repos/fagents.git`
- Working copy: `__INFRA_HOME__/workspace/fagents`
- DEPLOYLOG dir: `DEPLOYLOG/` in the fagents repo
- Routine pull instructions: `__INFRA_HOME__/workspace/fagents/DEPLOYLOG/README.md`
