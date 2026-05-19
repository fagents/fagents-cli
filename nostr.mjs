#!/usr/bin/env node
// nostr.mjs -- agent-first NIP-17 DM client over Nostr relays.
// All output is JSON. Agents are the users.
//
// Architecture (clone of whatsapp.mjs):
//   serve: long-running. Subscribes to kind:1059 gift wraps p-tagged to us
//          on every relay in NOSTR_RELAYS. Unwraps via nip17, verifies seal
//          signature + rumor.id + anti-impersonation, allow-lists by pubkey,
//          writes to nostr-spool/. Watches nostr-outbox/, builds NIP-17
//          envelopes via nip17.wrapEvent, publishes to relays (at-least-one-OK).
//   poll:  reads + deletes nostr-spool/*.jsonl -> one JSON line per msg.
//   send:  writes {to_npub, body} to nostr-outbox/ -> serve picks up.
//
// Credential loading mirrors whatsapp.mjs:
//   --env-file, --spool-dir, --outbox-dir flags for testing.
//   Otherwise, via: sudo -u fagents node nostr.mjs <command>; SUDO_USER -> CREDS_DIR.
//
// Commands:
//   nostr.mjs login [--nsec <key>]   -- generate or import nsec; MERGE env
//   nostr.mjs logout                 -- clear NOSTR_NSEC line; keep rest
//   nostr.mjs serve                  -- long-running relay subscriber + outbox sender
//   nostr.mjs poll                   -- drain spool to stdout
//   nostr.mjs send <npub> <body>     -- queue outgoing DM
//   nostr.mjs whoami                 -- print {npub, relays, allowed_npubs_count}
//   nostr.mjs help

import {
    readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync,
    mkdirSync, chmodSync, renameSync, statSync, watch,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
    nip17, nip19, nip44,
    finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent,
} from 'nostr-tools';
import WebSocket from 'ws';

// Platform-aware default for the credentials dir. Order:
//   1. FAGENTS_AGENTS_DIR env var (preserved when running outside sudo)
//   2. Auto-detect: /Users/fagents/.agents (macOS) if it exists, else
//      /home/fagents/.agents (Linux default)
// The daemon passes --env-file / --spool-dir / --outbox-dir / --pid-file
// explicitly so CREDS_DIR is irrelevant for the daemon's sudo-bridged calls.
// CREDS_DIR is only used by ad-hoc CLI invocations (whoami, send, etc.) that
// rely on defaults. Auto-detect makes those work on macOS even when sudo
// strips FAGENTS_AGENTS_DIR.
function defaultCredsDir() {
    if (process.env.FAGENTS_AGENTS_DIR) return process.env.FAGENTS_AGENTS_DIR;
    for (const c of ['/Users/fagents/.agents', '/home/fagents/.agents']) {
        try { if (existsSync(c)) return c; } catch {}
    }
    return '/home/fagents/.agents';
}
const CREDS_DIR = defaultCredsDir();

function err(msg) {
    process.stdout.write(JSON.stringify({ error: msg }) + '\n');
    process.exit(1);
}

// Sanitize relay-controlled log strings. A misbehaving or hostile relay can
// send a NOTICE / CLOSED reason / error message containing newlines, carriage
// returns, or other control chars; without normalization those would inject
// fake log lines into journald. Replace runs of C0/DEL with a single space,
// then cap length to bound journald cost.
// Function declaration (hoisted) so it's available while doServe runs --
// doServe is awaited from the dispatch switch, which leaves any `const`
// declared further down in the temporal dead zone for serve's lifetime.
function truncate(s, max = 200) {
    const str = (s == null ? '?' : String(s)).replace(/[\x00-\x1F\x7F]+/g, ' ');
    return str.length > max ? str.slice(0, max) + '...' : str;
}

// ── Arg parsing ──

const args = process.argv.slice(2);
let envFile = '';
let spoolDir = '';
let outboxDir = '';
let pidFile = '';

flagLoop: while (args.length && args[0].startsWith('--')) {
    const flag = args.shift();
    switch (flag) {
        case '--env-file':   envFile = args.shift() || ''; break;
        case '--spool-dir':  spoolDir = args.shift() || ''; break;
        case '--outbox-dir': outboxDir = args.shift() || ''; break;
        case '--pid-file':   pidFile = args.shift() || ''; break;
        default: args.unshift(flag); break flagLoop;
    }
}

const caller = process.env.SUDO_USER || '';
if (!envFile && caller)   envFile = `${CREDS_DIR}/${caller}/nostr.env`;
if (!spoolDir && caller)  spoolDir = `${CREDS_DIR}/${caller}/nostr-spool`;
if (!outboxDir && caller) outboxDir = `${CREDS_DIR}/${caller}/nostr-outbox`;
if (!pidFile && caller)   pidFile = `${CREDS_DIR}/${caller}/.nostr-serve.pid`;

if (!envFile) err('env file required: --env-file <path> or run via sudo -u <user>');

// ── Env helpers ──

function parseEnv(path) {
    const out = {};
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

// Atomic merge-write. Preserves keys not in `updates`. Writes mode 0600.
function writeEnvMerge(path, updates) {
    const existing = parseEnv(path);
    const merged = { ...existing };
    for (const [k, v] of Object.entries(updates)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
    }
    const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    const tmp = path + '.tmp';
    writeFileSync(tmp, lines, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
}

const DEFAULT_RELAYS = 'wss://relay.damus.io,wss://nos.lol,wss://nostr.wine';

function parseRelayList(s) {
    if (!s) return undefined;
    const out = String(s).split(',').map(x => x.trim()).filter(Boolean);
    return out.length ? out : undefined;
}

function loadEnv() {
    const env = parseEnv(envFile);
    return {
        nsec: env.NOSTR_NSEC || '',
        npub: env.NOSTR_NPUB || '',
        relays: parseRelayList(env.NOSTR_RELAYS || DEFAULT_RELAYS) || [],
        // Search-only relay override. Precedence: process.env wins (works
        // for tests / direct invocation), env-file second (sudo-safe since
        // sudo strips process env vars), then undefined -> caller falls
        // back to env.relays.
        searchRelays: parseRelayList(process.env.NOSTR_SEARCH_RELAYS) || parseRelayList(env.NOSTR_SEARCH_RELAYS),
        allowedNpubs: parseRelayList(env.NOSTR_ALLOWED_NPUBS) || [],
    };
}

// ── Sanitization (verbatim copy of fagents-mcp/src/sanitize.ts regex) ──
// Strips prompt-injection-smuggling Unicode classes from agent-visible
// public-timeline content. Same regex as the accepted email sanitizer:
// zero-width / full \p{Bidi_Control} / variation selectors / tag block.
const DANGEROUS = /[\u{061C}\u{200B}-\u{200F}\u{2060}\u{FEFF}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{FE00}-\u{FE0F}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

function sanitizeText(s) {
    if (s == null) return s;
    return String(s).replace(DANGEROUS, '');
}

function sanitizeTags(tags) {
    if (!Array.isArray(tags)) return tags;
    return tags.map(t => Array.isArray(t)
        ? t.map(v => typeof v === 'string' ? sanitizeText(v) : v)
        : t);
}

// ── Search arg parsing ──

function parseIntStrict(s, name) {
    if (typeof s !== 'string' || !/^-?\d+$/.test(s)) err(`bad-${name}`);
    return parseInt(s, 10);
}

function parseKind(s) {
    const n = parseIntStrict(s, 'kind');
    // Nostr kinds are non-negative per NIP-01 (range 0-65535 in practice).
    if (n < 0) err('bad-kind');
    return n;
}

function parseLimit(s) {
    const n = parseIntStrict(s, 'limit');
    if (n < 1 || n > 100) err('bad-limit');
    return n;
}

// Returns seconds. Throws via err() on garbage.
function parseSince(s) {
    if (typeof s !== 'string' || s.length === 0) err('bad-since');
    const m = s.match(/^(\d+)([smhd])?$/);
    if (!m) err('bad-since');
    const n = parseInt(m[1], 10);
    const unit = m[2] || 's';
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
    return n * mult;
}

function decodeNpubOrErr(s) {
    try { return decodeNpub(s); }
    catch { err('bad-author-npub'); }
}

// Returns the lowercase hex string if `s` is a 64-char hex, else null.
// Used to defend against attacker-shaped tag content from parent events
// in the reply path -- only validated lowercase hex flows into our own
// signed kind:1 reply tags.
function normHexId(s) {
    if (typeof s !== 'string' || !/^[0-9a-f]{64}$/i.test(s)) return null;
    return s.toLowerCase();
}

// Build NIP-10 marker-style reply tags from a resolved parent event.
// Pure function -- no I/O. Carried tag values are normalised through
// normHexId so malformed entries are dropped and emitted hex is always
// lowercase.
function buildReplyTags(parent, relayHint) {
    const tags = [];
    const parentId = normHexId(parent.id);
    const parentPub = normHexId(parent.pubkey);
    if (!parentId || !parentPub) {
        // Should never happen for a verifyEvent-passing parent, but
        // refuse to emit garbage if it somehow does.
        return tags;
    }

    // Look for a root marker in the parent's own e tags.
    let rootId = null;
    let rootAuthor = null;
    for (const t of parent.tags || []) {
        if (!Array.isArray(t) || t[0] !== 'e' || t[3] !== 'root') continue;
        const id = normHexId(t[1]);
        if (!id) continue;
        rootId = id;
        const author = normHexId(t[4]);
        if (author) rootAuthor = author;
        break;
    }

    if (rootId) {
        // Parent is a nested reply -- carry its root forward, mark parent as 'reply'.
        const rootTag = ['e', rootId, relayHint, 'root'];
        if (rootAuthor) rootTag.push(rootAuthor);
        tags.push(rootTag);
        tags.push(['e', parentId, relayHint, 'reply', parentPub]);
    } else {
        // Parent IS the root.
        tags.push(['e', parentId, relayHint, 'root', parentPub]);
    }

    // p tag chain: parent author first, then any valid p tags from parent, deduped.
    const seenP = new Set();
    tags.push(['p', parentPub]);
    seenP.add(parentPub);
    for (const t of parent.tags || []) {
        if (!Array.isArray(t) || t[0] !== 'p') continue;
        const pk = normHexId(t[1]);
        if (!pk || seenP.has(pk)) continue;
        tags.push(['p', pk]);
        seenP.add(pk);
    }

    return tags;
}

// ── Validation / encoding helpers ──

function decodeNsec(nsec) {
    if (!nsec.startsWith('nsec1')) throw new Error('invalid-nsec');
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') throw new Error('invalid-nsec');
    return decoded.data; // Uint8Array(32)
}

function decodeNpub(npub) {
    if (!npub.startsWith('npub1')) throw new Error('invalid-npub');
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') throw new Error('invalid-npub');
    return decoded.data; // hex string
}

function allowedSet(allowedNpubs) {
    const set = new Set();
    for (const n of allowedNpubs) {
        try { set.add(decodeNpub(n)); } catch { /* skip malformed entries */ }
    }
    return set;
}

// ── Commands ──

const cmd = args.shift() || 'help';

switch (cmd) {
    case 'login':  await doLogin(); break;
    case 'logout': doLogout(); break;
    case 'serve':  await doServe(); break;
    case 'poll':   doPoll(); break;
    case 'send':   await doSend(); break;
    case 'search': await doSearch(); break;
    case 'reply':  await doReply(); break;
    case 'whoami': doWhoami(); break;
    case 'help': case '--help': case '-h': default: doHelp(); break;
}

// ── login: generate or import nsec; MERGE into env ──

async function doLogin() {
    let nsecArg = '';
    while (args.length && args[0].startsWith('--')) {
        const flag = args.shift();
        if (flag === '--nsec') nsecArg = args.shift() || '';
        else err(`unknown flag: ${flag}`);
    }

    let sk;
    if (nsecArg) {
        try { sk = decodeNsec(nsecArg); }
        catch { err('invalid-nsec'); }
    } else {
        sk = generateSecretKey();
    }
    const pkHex = getPublicKey(sk);
    const nsecOut = nip19.nsecEncode(sk);
    const npubOut = nip19.npubEncode(pkHex);

    // MERGE: only set NSEC and NPUB. Initialize NOSTR_RELAYS only if absent.
    // Leave NOSTR_ALLOWED_NPUBS and any other keys untouched.
    const existing = parseEnv(envFile);
    const updates = { NOSTR_NSEC: nsecOut, NOSTR_NPUB: npubOut };
    if (!existing.NOSTR_RELAYS) updates.NOSTR_RELAYS = DEFAULT_RELAYS;

    writeEnvMerge(envFile, updates);

    const env = loadEnv();
    process.stdout.write(JSON.stringify({ npub: npubOut, relays: env.relays }) + '\n');
}

// ── logout: drop NOSTR_NSEC line; keep npub + relays + allow-list ──

function doLogout() {
    writeEnvMerge(envFile, { NOSTR_NSEC: null });
    process.stdout.write(JSON.stringify({ logged_out: true }) + '\n');
}

// ── whoami: print public identity, NEVER nsec ──

function doWhoami() {
    const env = loadEnv();
    if (!env.npub) err('not-logged-in');
    process.stdout.write(JSON.stringify({
        npub: env.npub,
        relays: env.relays,
        allowed_npubs_count: env.allowedNpubs.length,
    }) + '\n');
}

// ── poll: drain spool ──

function doPoll() {
    if (!existsSync(spoolDir)) process.exit(1);
    const files = readdirSync(spoolDir).filter(f => f.endsWith('.jsonl')).sort();
    if (files.length === 0) process.exit(1);
    let wrote = false;
    for (const f of files) {
        const fpath = join(spoolDir, f);
        try {
            const content = readFileSync(fpath, 'utf8').trim();
            if (content) {
                process.stdout.write(content + '\n');
                wrote = true;
            }
            unlinkSync(fpath);
        } catch { /* concurrent drain — skip */ }
    }
    process.exit(wrote ? 0 : 1);
}

// ── send: queue outgoing via outbox ──

async function doSend() {
    const npub = args.shift();
    const body = args.join(' ');
    if (!npub || !body) err('usage: send <npub> <body>');
    if (body.includes('\0')) err('null-byte-in-body');
    try { decodeNpub(npub); }
    catch { err('invalid-npub'); }

    if (!existsSync(outboxDir)) mkdirSync(outboxDir, { recursive: true, mode: 0o700 });

    const uuid = randomUUID();
    const fpath = join(outboxDir, `${uuid}.jsonl`);
    writeFileSync(fpath, JSON.stringify({ to_npub: npub, body, ts: new Date().toISOString() }), { mode: 0o600 });
    chmodSync(fpath, 0o600);

    // Wait up to 5s for serve to pick it up
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (!existsSync(fpath)) {
            process.stdout.write(JSON.stringify({ ok: true, to: npub, uuid }) + '\n');
            return;
        }
        await sleep(200);
    }
    process.stdout.write(JSON.stringify({ ok: true, to: npub, uuid, queued: true, note: 'serve may not be running' }) + '\n');
}

// ── search: query public timeline by hashtag (NIP-01 #t) or keyword (NIP-50) ──

async function doSearch() {
    let tag = '', author = '';
    let kind = 1, limit = 20, since = 0;
    const positional = [];
    while (args.length) {
        const a = args.shift();
        if (a === '--tag') {
            const v = args.shift();
            if (!v || v.startsWith('--')) err('bad-tag');
            tag = v;
        }
        else if (a === '--kind')   kind = parseKind(args.shift());
        else if (a === '--limit')  limit = parseLimit(args.shift());
        else if (a === '--since')  since = parseSince(args.shift());
        else if (a === '--author') author = decodeNpubOrErr(args.shift());
        else if (a.startsWith('--')) err(`unknown-flag-${a.slice(2)}`);
        else positional.push(a);
    }
    const keyword = positional.join(' ').trim();
    if (!tag && !keyword) err('usage: search [--tag <topic>] [<keyword>]');
    if (tag && keyword) err('use-tag-or-keyword-not-both');

    const filter = { kinds: [kind], limit };
    if (since) filter.since = Math.floor(Date.now() / 1000) - since;
    if (author) filter.authors = [author];
    if (tag) filter['#t'] = [tag.replace(/^#/, '').toLowerCase()];
    if (keyword) filter.search = keyword;

    const env = loadEnv();
    const searchRelays = env.searchRelays || env.relays;

    const timeoutMs = parseInt(process.env.NOSTR_SEARCH_TIMEOUT_MS || '5000', 10);
    const seen = new Set();
    const events = [];

    await Promise.all(searchRelays.map(url => queryRelay(url, filter, timeoutMs, (ev) => {
        // Cheap dedup first -- a popular event seen on N relays would
        // otherwise re-run verifyEvent N times (schnorr verify ~1ms each).
        if (seen.has(ev.id)) return;
        if (!verifyEvent(ev)) return;
        seen.add(ev.id);
        events.push(ev);
    })));

    events.sort((a, b) => b.created_at - a.created_at);
    for (const ev of events) {
        process.stdout.write(JSON.stringify({
            kind: ev.kind,
            id: ev.id,
            pubkey: ev.pubkey,
            npub: nip19.npubEncode(ev.pubkey),
            created_at: ev.created_at,
            content: sanitizeText(ev.content),
            tags: sanitizeTags(ev.tags),
        }) + '\n');
    }
}

// One-shot REQ. Open WS, send REQ, collect EVENTs via onEvent until EOSE
// or timeout, send CLOSE, resolve. Best-effort: errors and timeouts are
// swallowed so a single bad relay does not abort the fan-out.
function queryRelay(url, filter, timeoutMs, onEvent) {
    return new Promise((resolve) => {
        let ws;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            try { ws && ws.close(); } catch {}
            resolve();
        };
        try { ws = new WebSocket(url); } catch { return resolve(); }
        const subId = `search-${randomUUID()}`;
        const timer = setTimeout(finish, timeoutMs);
        ws.on('open', () => {
            try { ws.send(JSON.stringify(['REQ', subId, filter])); }
            catch { clearTimeout(timer); finish(); }
        });
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
                try { onEvent(msg[2]); } catch { /* keep relay-side flow alive */ }
            } else if (msg[0] === 'EOSE' && msg[1] === subId) {
                try { ws.send(JSON.stringify(['CLOSE', subId])); } catch {}
                clearTimeout(timer);
                finish();
            } else if (msg[0] === 'CLOSED' && msg[1] === subId) {
                // Relay rejected THIS sub explicitly (NIP-50 filter
                // unsupported, auth required, rate-limited, etc). Exit
                // fast instead of waiting the full timeout. truncate()
                // strips control chars so the relay can't forge log
                // lines via newlines in the reason.
                process.stderr.write(`relay-closed url=${url} reason=${truncate(msg[2])}\n`);
                clearTimeout(timer);
                finish();
            } else if (msg[0] === 'NOTICE') {
                // NOTICE is not subscription-scoped per NIP-01 -- it can
                // be a relay greeting or warning unrelated to our REQ.
                // Log + continue waiting for EVENTs / EOSE. Don't fast-
                // fail or we'd silently drop legitimate results from
                // chatty relays.
                process.stderr.write(`relay-notice url=${url} msg=${truncate(msg[1])}\n`);
            }
        });
        ws.on('error', () => { clearTimeout(timer); finish(); });
        ws.on('close', () => { clearTimeout(timer); finish(); });
    });
}

// ── reply: publish a kind:1 reply to a parent event ──
//
// CLI surface: nostr.mjs reply <parent-event-id> <body...>
// Auto-resolves the parent via one-shot REQ (verifyEvent + id match +
// kind:1 enforced), builds NIP-10 marker-style reply tags from the
// resolved parent, sanitises the body, signs as our nsec, publishes to
// NOSTR_RELAYS. Returns {ok, id, parent, tags} on at-least-one-OK.

async function doReply() {
    const parentId = normHexId(args.shift());
    if (!parentId) err('bad-parent-event-id');

    const body = args.join(' ').trim();
    if (!body) err('usage: reply <parent-event-id> <body>');
    if (body.includes('\0')) err('null-byte-in-body');

    const env = loadEnv();
    if (!env.nsec) err('not-logged-in');
    let sk;
    try { sk = decodeNsec(env.nsec); } catch { err('nsec-decode-failed'); }

    // Sanitise outbound BEFORE signing. A body of only smuggling chars
    // would sign+publish empty content -- refuse rather than emit a
    // signed empty kind:1.
    const cleanBody = sanitizeText(body);
    if (!cleanBody.trim()) err('empty-body-after-sanitize');

    const timeoutMs = parseInt(process.env.NOSTR_REPLY_TIMEOUT_MS || '5000', 10);

    // Resolve the parent. resolveEvent enforces sig + id match + kind:1.
    const resolved = await resolveEvent(parentId, env.relays, timeoutMs);
    if (!resolved) err('parent-not-found');
    const { event: parent, relay: parentRelay } = resolved;

    const tags = buildReplyTags(parent, parentRelay);
    const ev = finalizeEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: cleanBody,
    }, sk);

    const ok = await publishOneShot(ev, env.relays, timeoutMs);
    if (!ok) err('publish-failed');

    process.stdout.write(JSON.stringify({
        ok: true,
        id: ev.id,
        parent: parentId,
        tags,
    }) + '\n');
}

// Race ephemeral sockets across `relays`. Calls `perRelay({ ws, url,
// idx, finish, settleRelay })` for each relay so the caller can wire
// REQ/EVENT/OK-shaped handlers using the provided controls. raceRelays
// owns the shared lifecycle: timer, sockets[] array, idempotent
// resolvedOnce flag, per-relay settlement, and the all-sockets-close on
// finish that prevents the multi-relay post-success hang (silent peer
// sockets would otherwise keep the Node process alive after stdout).
//
// Resolves with whatever the first finish(val) call passed. If every
// relay settles without finish(), or the timer fires, resolves with
// `defaultVal`.
function raceRelays(relays, timeoutMs, defaultVal, perRelay) {
    return new Promise((resolve) => {
        if (!relays.length) return resolve(defaultVal);

        const sockets = [];
        const relayDone = new Array(relays.length).fill(false);
        let outstanding = relays.length;
        let resolvedOnce = false;
        let timer;

        const finish = (val) => {
            if (resolvedOnce) return;
            resolvedOnce = true;
            clearTimeout(timer);
            for (const s of sockets) { try { s.close(); } catch {} }
            resolve(val);
        };

        const settleRelay = (idx) => {
            if (relayDone[idx]) return;
            relayDone[idx] = true;
            if (--outstanding === 0) finish(defaultVal);
        };

        timer = setTimeout(() => finish(defaultVal), timeoutMs);

        relays.forEach((url, idx) => {
            let ws;
            try { ws = new WebSocket(url); }
            catch { settleRelay(idx); return; }
            sockets.push(ws);
            ws.on('error', () => settleRelay(idx));
            ws.on('close', () => settleRelay(idx));
            perRelay({ ws, url, idx, finish, settleRelay });
        });
    });
}

// One-shot REQ for a single event id. First event that passes
// verifyEvent + id match + kind:1 wins. Returns {event, relay} or null.
function resolveEvent(id, relays, timeoutMs) {
    return raceRelays(relays, timeoutMs, null, ({ ws, url, idx, finish, settleRelay }) => {
        const subId = `resolve-${randomUUID()}`;
        ws.on('open', () => {
            try { ws.send(JSON.stringify(['REQ', subId, { ids: [id], limit: 1 }])); }
            catch { settleRelay(idx); }
        });
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
                const ev = msg[2];
                // Strict gating: signature valid AND relay-claimed id
                // matches what we asked for AND kind:1.
                if (ev.id !== id) return;
                if (ev.kind !== 1) return;
                if (!verifyEvent(ev)) return;
                finish({ event: ev, relay: url });
            } else if ((msg[0] === 'EOSE' && msg[1] === subId) ||
                       (msg[0] === 'CLOSED' && msg[1] === subId)) {
                settleRelay(idx);
            } else if (msg[0] === 'NOTICE') {
                process.stderr.write(`relay-notice url=${url} msg=${truncate(msg[1])}\n`);
            }
        });
    });
}

// One-shot EVENT publish to all relays. Resolves true on first OK true,
// false on timeout / all-relays-failed. Ephemeral sockets (no reuse of
// serve's long-running outbox pool).
function publishOneShot(event, relays, timeoutMs) {
    const frame = JSON.stringify(['EVENT', event]);
    return raceRelays(relays, timeoutMs, false, ({ ws, url, idx, finish, settleRelay }) => {
        ws.on('open', () => {
            try { ws.send(frame); }
            catch { settleRelay(idx); }
        });
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg[0] === 'OK' && msg[1] === event.id) {
                if (msg[2] === true) {
                    finish(true);
                } else {
                    process.stderr.write(`publish-rejected url=${url} reason=${truncate(msg[3])}\n`);
                    settleRelay(idx);
                }
            } else if (msg[0] === 'NOTICE') {
                process.stderr.write(`relay-notice url=${url} msg=${truncate(msg[1])}\n`);
            }
        });
    });
}

// ── help ──

function doHelp() {
    process.stdout.write(JSON.stringify({
        commands: [
            'login [--nsec <key>]',
            'logout',
            'serve',
            'poll',
            'send <npub> <body>',
            'search [--tag <topic>] [--kind n] [--limit n] [--since 7d] [--author <npub>] [<keyword>]',
            'reply <parent-event-id> <body>',
            'whoami',
            'help',
        ],
    }) + '\n');
}

// ── serve: relay subscription + outbox watcher ──

async function doServe() {
    const env = loadEnv();
    if (!env.nsec) err('not-logged-in');
    let sk;
    try { sk = decodeNsec(env.nsec); }
    catch { err('nsec-decode-failed'); }
    const myHex = getPublicKey(sk);
    const allowSet = allowedSet(env.allowedNpubs);

    if (!existsSync(spoolDir)) mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    if (!existsSync(outboxDir)) mkdirSync(outboxDir, { recursive: true, mode: 0o700 });

    // PID file for liveness check by ensure_nostr_serve()
    if (pidFile) {
        writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
        chmodSync(pidFile, 0o600);
    }

    const cleanup = () => {
        if (pidFile && existsSync(pidFile)) { try { unlinkSync(pidFile); } catch {} }
        process.exit(0);
    };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    // Dedup of wrap event ids, bounded FIFO to 10k. Poison-resistance
    // (only-add-after-spool-write) is enforced in handleInbound.
    const seenWrapIds = new Set();
    const markSeen = (id) => {
        seenWrapIds.add(id);
        if (seenWrapIds.size > 10000) {
            seenWrapIds.delete(seenWrapIds.values().next().value);
        }
    };

    // NIP-17 section 6 kind:10050 inbox-relay list, built and serialized once.
    // Sent on every socket open (incl. reconnects); relays handle
    // replaceable-event dedup.
    const inboxListEvent = finalizeEvent({
        kind: 10050,
        created_at: Math.floor(Date.now() / 1000),
        tags: env.relays.map(r => ['relay', r]),
        content: '',
    }, sk);
    const inboxListFrame = JSON.stringify(['EVENT', inboxListEvent]);

    const sockets = new Map(); // url -> { ws, state, pending }
    for (const url of env.relays) {
        openRelay(url, sockets, myHex, sk, allowSet, seenWrapIds, markSeen, inboxListEvent, inboxListFrame);
    }

    // Outbox watcher: scan now, then watch for new files.
    const seen = new Set();
    const drain = async () => {
        if (!existsSync(outboxDir)) return;
        for (const f of readdirSync(outboxDir).filter(x => x.endsWith('.jsonl'))) {
            if (seen.has(f)) continue;
            seen.add(f);
            const fpath = join(outboxDir, f);
            try {
                const { to_npub, body } = JSON.parse(readFileSync(fpath, 'utf8'));
                const recipientHex = decodeNpub(to_npub);
                const wrap = nip17.wrapEvent(sk, { publicKey: recipientHex }, body);
                const ok = await publishToRelays(wrap, sockets);
                if (ok) unlinkSync(fpath);
                // else: leave for retry; remove from seen so it tries again
                else seen.delete(f);
            } catch (e) {
                process.stderr.write(`serve-send-error file=${f} err=${e.message}\n`);
                seen.delete(f);
            }
        }
    };
    try {
        watch(outboxDir, { persistent: true }, () => { drain().catch(() => {}); });
    } catch { /* fall back to interval polling */ }
    setInterval(() => { drain().catch(() => {}); }, 250);

    // Stay alive
    await new Promise(() => {});
}

function openRelay(url, sockets, myHex, sk, allowSet, seenWrapIds, markSeen, inboxListEvent, inboxListFrame) {
    // Reconnect backoff. Reset only when subscription is healthy (EOSE
    // received, OR 30s of stability post-open). The relay opening the
    // WebSocket is not the same as the relay accepting our subscription;
    // a persistent CLOSED (auth-required, rate-limited, blocked, ...) must
    // back off exponentially or we spin in a 1s reconnect loop.
    let backoff = 1000;
    let stableTimer = null;
    let pingTimer = null;
    let lastPongAt = 0;

    const clearStable = () => {
        if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
    };
    const clearPing = () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    };

    const connect = () => {
        const ws = new WebSocket(url);
        sockets.set(url, { ws, state: 'connecting', pending: new Map() });

        ws.on('open', () => {
            sockets.get(url).state = 'open';
            // NOTE: do NOT reset backoff here. Wait for EOSE or 30s stability.

            // Subscribe to kind:1059 wraps p-tagged to me, last 7 days.
            const since = Math.floor(Date.now() / 1000) - 7 * 86400;
            try {
                ws.send(JSON.stringify(['REQ', 'fagents-dms', { kinds: [1059], '#p': [myHex], since }]));
                process.stderr.write(`subscribed url=${url}\n`);
            } catch (e) {
                process.stderr.write(`subscribe-failed url=${url} err=${truncate(e.message)}\n`);
            }

            // Publish NIP-17 inbox-relay list (kind:10050). Fire-and-forget;
            // OK frame logs success. inboxListFrame is precomputed at startup.
            try {
                ws.send(inboxListFrame);
                process.stderr.write(`inbox-list-publish-attempt url=${url}\n`);
            } catch (e) {
                process.stderr.write(`inbox-list-publish-failed url=${url} err=${truncate(e.message)}\n`);
            }

            // Reset backoff after 30s of stability (no CLOSED). EOSE will
            // reset it sooner if the relay sends one (which it should per
            // NIP-01, even on empty results).
            clearStable();
            stableTimer = setTimeout(() => {
                backoff = 1000;
                stableTimer = null;
            }, 30000);

            // Keepalive: ping every 30s. If no pong for 90s, force-close to
            // trigger reconnect (handles half-open conns that don't fire
            // 'close' on their own).
            lastPongAt = Date.now();
            clearPing();
            pingTimer = setInterval(() => {
                if (Date.now() - lastPongAt > 90000) {
                    process.stderr.write(`relay-stale-pong url=${url}\n`);
                    try { ws.terminate(); } catch {}
                    return;
                }
                try { ws.ping(); } catch {}
            }, 30000);
        });

        ws.on('pong', () => { lastPongAt = Date.now(); });

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg[0] === 'EVENT' && msg[1] === 'fagents-dms') {
                    handleInbound(msg[2], sk, myHex, allowSet, seenWrapIds, markSeen);
                } else if (msg[0] === 'OK' && msg[1]) {
                    if (msg[1] === inboxListEvent.id && msg[2] === true) {
                        process.stderr.write(`inbox-list-published url=${url}\n`);
                    }
                    const entry = sockets.get(url)?.pending.get(msg[1]);
                    if (entry) entry.resolve(msg[2] === true);
                } else if (msg[0] === 'EOSE' && msg[1] === 'fagents-dms') {
                    // Sub accepted, now in live mode. Safe to reset backoff.
                    backoff = 1000;
                    clearStable();
                    process.stderr.write(`relay-eose url=${url}\n`);
                } else if (msg[0] === 'CLOSED' && msg[1] === 'fagents-dms') {
                    process.stderr.write(`relay-closed-sub url=${url} reason=${truncate(msg[2])}\n`);
                    clearStable();
                    // Force-close. ws.on('close') -> reopen() with the
                    // current (un-reset) backoff so persistent CLOSED gets
                    // real exponential spacing.
                    try { ws.terminate(); } catch {}
                } else if (msg[0] === 'NOTICE') {
                    process.stderr.write(`relay-notice url=${url} msg=${truncate(msg[1])}\n`);
                }
            } catch { /* malformed relay frame -- ignore */ }
        });

        const reopen = () => {
            clearStable();
            clearPing();
            const entry = sockets.get(url);
            if (entry) entry.state = 'closed';
            setTimeout(connect, backoff);
            backoff = Math.min(backoff * 2, 60000);
        };
        ws.on('close', reopen);
        ws.on('error', (e) => {
            process.stderr.write(`relay-error url=${url} err=${truncate(e?.message)}\n`);
            try { ws.close(); } catch {}
        });
    };
    connect();
}

// Inbound: unwrap + verify per NIP-17/NIP-59, allow-list, write spool.
function handleInbound(wrap, sk, myHex, allowSet, seenWrapIds, markSeen) {
    try {
        if (!wrap || wrap.kind !== 1059) return;
        // Cheap dedup check BEFORE expensive crypto. Only valid spool-written
        // wraps are in this set (markSeen runs only after successful write),
        // so an invalid frame with the same id as a future valid event can
        // never poison the cache.
        if (seenWrapIds.has(wrap.id)) return;
        if (!verifyEvent(wrap)) return reject(wrap, 'wrap-sig-invalid');
        if (!wrap.tags?.some(t => t[0] === 'p' && t[1] === myHex)) return reject(wrap, 'wrap-not-for-me');

        // Decrypt wrap content -> seal JSON
        const ck1 = nip44.v2.utils.getConversationKey(sk, wrap.pubkey);
        let seal;
        try {
            seal = JSON.parse(nip44.v2.decrypt(wrap.content, ck1));
        } catch { return reject(wrap, 'wrap-decrypt-failed'); }

        if (seal.kind !== 13) return reject(wrap, 'seal-wrong-kind');
        if (!verifyEvent(seal)) return reject(wrap, 'seal-sig-invalid');

        // Decrypt seal content -> rumor JSON
        const ck2 = nip44.v2.utils.getConversationKey(sk, seal.pubkey);
        let rumor;
        try {
            rumor = JSON.parse(nip44.v2.decrypt(seal.content, ck2));
        } catch { return reject(wrap, 'seal-decrypt-failed'); }

        if (rumor.kind !== 14) return reject(wrap, 'rumor-wrong-kind');
        if (!rumor.id) return reject(wrap, 'rumor-missing-id');
        if (rumor.id !== getEventHash(rumor)) return reject(wrap, 'rumor-id-mismatch');
        if (rumor.sig) return reject(wrap, 'rumor-must-not-be-signed');
        if (rumor.pubkey !== seal.pubkey) return reject(wrap, 'seal-rumor-pubkey-mismatch');
        if (!rumor.tags?.some(t => t[0] === 'p' && t[1] === myHex)) return reject(wrap, 'rumor-not-for-me');

        // Allow-list check (in hex)
        if (!allowSet.has(rumor.pubkey)) {
            process.stderr.write(`drop wrap=${wrap.id} reason=sender-not-allowed sender=${rumor.pubkey}\n`);
            return;
        }

        // Write spool
        if (!existsSync(spoolDir)) mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
        const fpath = join(spoolDir, `${randomUUID()}.jsonl`);
        const fromNpub = nip19.npubEncode(rumor.pubkey);
        const record = {
            ts: new Date(rumor.created_at * 1000).toISOString(),
            from_npub: fromNpub,
            from_hex: rumor.pubkey,
            body: rumor.content,
            wrap_event_id: wrap.id,
            rumor_id: rumor.id,
        };
        writeFileSync(fpath, JSON.stringify(record), { mode: 0o600 });
        chmodSync(fpath, 0o600);

        // Mark seen ONLY after successful spool write. Invalid frames that
        // hit any earlier `return reject(...)` never enter the dedup cache.
        markSeen(wrap.id);
    } catch (e) {
        process.stderr.write(`handleInbound exception err=${e.message}\n`);
    }
}

function reject(wrap, reason) {
    process.stderr.write(`drop wrap=${wrap?.id || '?'} reason=${reason}\n`);
}

// Publish a signed event to all open relays. Resolve true if any relay OKs within 5s.
async function publishToRelays(event, sockets) {
    const frame = JSON.stringify(['EVENT', event]);
    let resolveAll;
    const done = new Promise(r => { resolveAll = r; });
    let outstanding = 0;
    let anyOk = false;
    let resolved = false;

    const settle = () => {
        if (resolved) return;
        if (outstanding === 0 || anyOk) {
            resolved = true;
            resolveAll(anyOk);
        }
    };

    for (const [, sock] of sockets) {
        if (sock.state !== 'open' || sock.ws.readyState !== 1) continue;
        outstanding++;
        const promise = new Promise((res) => {
            sock.pending.set(event.id, { resolve: (ok) => { sock.pending.delete(event.id); res(ok); } });
            try { sock.ws.send(frame); } catch { res(false); }
        });
        promise.then((ok) => {
            outstanding--;
            if (ok) anyOk = true;
            settle();
        });
    }
    if (outstanding === 0) return false;

    const timeout = sleep(5000).then(() => { resolved || (resolved = true, resolveAll(anyOk)); });
    return Promise.race([done, timeout.then(() => anyOk)]);
}
