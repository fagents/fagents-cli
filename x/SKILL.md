---
name: x
description: Search and post on X (Twitter) via API v2.
argument-hint: "[search|tweet|user|tweets|post|reply] [args...]"
allowed-tools: Bash(sudo -u fagents */x.sh *)
---

# X (Twitter)

Search and post on X via API v2. Bearer token for reads, OAuth 1.0a for writes.

## Usage

All commands go through sudo — you never see the API keys:

```bash
CLI=/home/fagents/workspace/fagents-cli
sudo -u fagents $CLI/x.sh <command> [args...]
```

## Commands

### search
Search recent tweets. Returns up to `--count` results (default 10).
```bash
sudo -u fagents $CLI/x.sh search "fagents AI"
sudo -u fagents $CLI/x.sh search "from:elonmusk" --count 5
```

### tweet
Look up a single tweet by ID.
```bash
sudo -u fagents $CLI/x.sh tweet 1234567890
```

### user
Look up a user by username. The `@` prefix is stripped automatically.
```bash
sudo -u fagents $CLI/x.sh user @elonmusk
sudo -u fagents $CLI/x.sh user elonmusk
```

### tweets
Get a user's recent tweets. Resolves username to ID, then fetches tweets.
```bash
sudo -u fagents $CLI/x.sh tweets elonmusk
sudo -u fagents $CLI/x.sh tweets elonmusk --count 5
```

### post
Post a new tweet (requires OAuth credentials).
```bash
sudo -u fagents $CLI/x.sh post "Hello from fagents"
```

### reply
Reply to an existing tweet (requires OAuth credentials).
```bash
sudo -u fagents $CLI/x.sh reply 1234567890 "Great thread!"
```

## Notes

- All output is JSON — parse with `jq`
- Read commands use bearer token (app-only auth)
- Write commands (post, reply) use OAuth 1.0a (user-context auth)
- X API v2 is pay-per-usage (credit-based, no subscriptions)
- Do NOT try to access API keys or tokens directly — credential isolation via sudo
