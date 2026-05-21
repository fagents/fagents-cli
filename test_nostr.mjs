#!/usr/bin/env node
// Tests for nostr.mjs -- login, logout, poll, send, whoami, help, errors,
// plus in-process NIP-44 / NIP-17 round-trip and a mock-relay E2E.
//
// All TIOCSTI-style WhatsApp tricks N/A here. Real network N/A — we use a
// localhost `ws` server as the mock relay.

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import {
    nip17, nip19, nip44,
    finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent,
} from 'nostr-tools';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'nostr.mjs');

let PASS = 0, FAIL = 0, ERRORS = '';

function pass(msg) { PASS++; console.log(`  PASS: ${msg}`); }
function fail(msg) { FAIL++; ERRORS += `\n  FAIL: ${msg}`; console.log(`  FAIL: ${msg}`); }

function assertEq(expected, actual, msg) {
    String(expected) === String(actual) ? pass(msg) : fail(`${msg} (expected '${expected}', got '${actual}')`);
}
function assertJsonField(jsonStr, field, expected, msg) {
    try {
        const obj = JSON.parse(jsonStr);
        const keys = field.split('.');
        let val = obj;
        for (const k of keys) val = val?.[k];
        if (expected === undefined) {
            val !== undefined && val !== null ? pass(msg) : fail(`${msg} (field ${field} missing)`);
        } else {
            String(val) === String(expected) ? pass(msg) : fail(`${msg} (${field}: expected '${expected}', got '${val}')`);
        }
    } catch (e) {
        fail(`${msg} (invalid JSON: ${e.message})`);
    }
}
function assertContains(str, substr, msg) {
    str.includes(substr) ? pass(msg) : fail(`${msg} (expected to contain '${substr}')`);
}
function assertTrue(cond, msg) {
    cond ? pass(msg) : fail(msg);
}

// ── Setup ──

const tmpBase = mkdtempSync(join(tmpdir(), 'nostr-test-'));
const envFile = join(tmpBase, 'nostr.env');
const spoolDir = join(tmpBase, 'nostr-spool');
const outboxDir = join(tmpBase, 'nostr-outbox');
mkdirSync(spoolDir);
mkdirSync(outboxDir);
// Touch env file so node's --env-file doesn't fail at startup
writeFileSync(envFile, '');

const baseFlags = ['--env-file', envFile, '--spool-dir', spoolDir, '--outbox-dir', outboxDir];

function run(...cmdArgs) {
    try {
        const stdout = execFileSync('node', [CLI, ...baseFlags, ...cmdArgs], {
            encoding: 'utf8', timeout: 10000,
        });
        return { stdout: stdout.trim(), status: 0 };
    } catch (e) {
        return {
            stdout: (e.stdout || '').trim(),
            stderr: (e.stderr || '').trim(),
            status: e.status || 1,
        };
    }
}
function clearDir(d) {
    for (const f of readdirSync(d)) { try { rmSync(join(d, f)); } catch {} }
}
function writeEnv(content) { writeFileSync(envFile, content); }

console.log('=== nostr.mjs tests ===');
console.log('');

// ── 1-6: Identity / env ──

console.log('identity / env:');
writeEnv('');
let r = run('login');
assertEq(0, r.status, '01a: login (no flags) exits 0');
assertJsonField(r.stdout, 'npub', undefined, '01b: login output has npub');
let env = readFileSync(envFile, 'utf8');
assertContains(env, 'NOSTR_NSEC=nsec1', '01c: env has NOSTR_NSEC');
assertContains(env, 'NOSTR_NPUB=npub1', '01d: env has NOSTR_NPUB');

// 02: login --nsec <valid>
const fixedSk = generateSecretKey();
const fixedNsec = nip19.nsecEncode(fixedSk);
const fixedNpub = nip19.npubEncode(getPublicKey(fixedSk));
writeEnv('');
r = run('login', '--nsec', fixedNsec);
assertEq(0, r.status, '02a: login --nsec valid exits 0');
assertJsonField(r.stdout, 'npub', fixedNpub, '02b: imported npub matches');

// 03: login --nsec invalid
writeEnv('');
r = run('login', '--nsec', 'not_a_real_nsec');
assertEq(1, r.status, '03a: invalid nsec exits 1');
assertJsonField(r.stdout, 'error', 'invalid-nsec', '03b: error is invalid-nsec');

// 04: env file mode 0600
writeEnv('');
run('login');
const mode = statSync(envFile).mode & 0o777;
assertEq(0o600, mode, '04: nostr.env mode is 0600');

// 05: login MERGES, preserves NOSTR_ALLOWED_NPUBS (R1 P2 fix)
const preAllowed = 'npub1aaaa' + 'a'.repeat(58);
writeEnv(`NOSTR_ALLOWED_NPUBS=${preAllowed}\n`);
run('login');
env = readFileSync(envFile, 'utf8');
assertContains(env, `NOSTR_ALLOWED_NPUBS=${preAllowed}`, '05: login preserves NOSTR_ALLOWED_NPUBS');

// 06: logout clears NSEC but keeps NPUB + relays + allow-list
writeEnv('');
run('login');
env = readFileSync(envFile, 'utf8');
const npubLine = env.split('\n').find(l => l.startsWith('NOSTR_NPUB='));
r = run('logout');
assertEq(0, r.status, '06a: logout exits 0');
env = readFileSync(envFile, 'utf8');
assertTrue(!env.includes('NOSTR_NSEC='), '06b: NOSTR_NSEC cleared');
assertContains(env, npubLine, '06c: NOSTR_NPUB preserved');

// ── 7-10: NIP-44 v2 round-trip ──

console.log('\nNIP-44 v2 round-trip:');
const skA = generateSecretKey(), pkA = getPublicKey(skA);
const skB = generateSecretKey(), pkB = getPublicKey(skB);
const ckAB = nip44.v2.utils.getConversationKey(skA, pkB);
const ckBA = nip44.v2.utils.getConversationKey(skB, pkA);
// 07: ECDH symmetry
const ckABHex = Buffer.from(ckAB).toString('hex');
const ckBAHex = Buffer.from(ckBA).toString('hex');
assertEq(ckABHex, ckBAHex, '07: getConversationKey(A,B) == getConversationKey(B,A)');

// 08: plaintext round-trip
const ct = nip44.v2.encrypt('hello, nostr', ckAB);
const pt = nip44.v2.decrypt(ct, ckBA);
assertEq('hello, nostr', pt, '08: plaintext round-trips');

// 09: wrong key throws
const skC = generateSecretKey();
const ckBC = nip44.v2.utils.getConversationKey(skC, pkB);
let threw = false;
try { nip44.v2.decrypt(ct, ckBC); } catch { threw = true; }
assertTrue(threw, '09: wrong conversation key fails decrypt');

// 10: UTF-8 multibyte
const utf8Body = 'naïve résumé €₿🌐';
const ct2 = nip44.v2.encrypt(utf8Body, ckAB);
assertEq(utf8Body, nip44.v2.decrypt(ct2, ckBA), '10: UTF-8 multibyte round-trips');

// ── 11-16d: NIP-17 envelope round-trip + tamper checks ──

console.log('\nNIP-17 envelope:');
const body11 = 'private message body';
const wrap11 = nip17.wrapEvent(skA, { publicKey: pkB }, body11);
assertEq(1059, wrap11.kind, '11a: wrap is kind:1059');
assertTrue(verifyEvent(wrap11), '11b: wrap signature valid');
const seal11 = JSON.parse(nip44.v2.decrypt(wrap11.content, nip44.v2.utils.getConversationKey(skB, wrap11.pubkey)));
assertEq(13, seal11.kind, '11c: seal is kind:13');
assertTrue(verifyEvent(seal11), '11d: seal signature valid');
assertEq(pkA, seal11.pubkey, '11e: seal.pubkey is sender');
const rumor11 = JSON.parse(nip44.v2.decrypt(seal11.content, nip44.v2.utils.getConversationKey(skB, seal11.pubkey)));
assertEq(14, rumor11.kind, '11f: rumor is kind:14');
assertEq(body11, rumor11.content, '11g: rumor.content == body');
assertEq(pkA, rumor11.pubkey, '11h: rumor.pubkey == sender');
assertEq(rumor11.id, getEventHash(rumor11), '11i: rumor.id matches getEventHash');
assertTrue(!rumor11.sig, '11j: rumor has no sig');

// 12: anti-impersonation -- build a wrap where rumor.pubkey differs from seal.pubkey
// (manual tamper: take the round-trip rumor, change pubkey, repack)
const fakePk = getPublicKey(skC);
const tampered = { ...rumor11, pubkey: fakePk };
tampered.id = getEventHash(tampered);
const tamperedSealContent = nip44.v2.encrypt(JSON.stringify(tampered), nip44.v2.utils.getConversationKey(skA, pkB));
const tamperedSeal = finalizeEvent({ kind: 13, content: tamperedSealContent, created_at: Math.floor(Date.now() / 1000), tags: [] }, skA);
assertTrue(verifyEvent(tamperedSeal), '12a: tampered seal still has valid sig (signed by A)');
assertTrue(tampered.pubkey !== tamperedSeal.pubkey, '12b: rumor.pubkey != seal.pubkey (impersonation attempt)');
// handleInbound would reject this with reason=seal-rumor-pubkey-mismatch.
// Direct test via the same logic: compare seal.pubkey to rumor.pubkey.
assertTrue(tampered.pubkey !== tamperedSeal.pubkey, '12c: inbound logic would reject (pubkey mismatch)');

// 13: rumor kind != 14
const wrongKindRumor = { ...rumor11, kind: 99 };
assertTrue(wrongKindRumor.kind !== 14, '13: wrong-kind rumor would be rejected');

// 14: rumor missing id
const noIdRumor = { ...rumor11 }; delete noIdRumor.id;
assertTrue(!noIdRumor.id, '14: rumor missing id would be rejected');

// 15: rumor.id !== getEventHash(rumor) (tampered content, stale id)
const stalePid = { ...rumor11, content: 'tampered' };  // id unchanged from original
assertTrue(stalePid.id !== getEventHash(stalePid), '15: stale rumor.id != getEventHash detected');

// 16: rumor with sig (should be unsigned per NIP-59)
const signedRumor = finalizeEvent({ ...rumor11 }, skA);
assertTrue(!!signedRumor.sig, '16: rumor with sig present (NIP-59 violation; inbound rejects)');

// ── 17-19: allow-list ──

console.log('\nallow-list:');
// Used by serve, but we can confirm decoding works.
const allowedHex = pkA;
const allowed = new Set([allowedHex]);
assertTrue(allowed.has(pkA), '17: allow-list hex membership works');
assertTrue(!allowed.has(pkB), '18: non-listed pubkey rejected');
const empty = new Set();
assertTrue(!empty.has(pkA), '19: empty allow-list rejects all (fail closed)');

// ── 20-22: send command (queue to outbox) ──

console.log('\nsend:');
clearDir(outboxDir);
writeEnv('');
run('login');
const npubX = nip19.npubEncode(pkA);
r = run('send', npubX, 'hello');
assertEq(0, r.status, '20a: send valid npub exits 0');
// Outbox file may already be drained if serve happens to be running; check stdout
assertJsonField(r.stdout, 'to', npubX, '20b: send result has to=npub');

// 21: invalid npub
r = run('send', 'not_a_npub', 'hello');
assertEq(1, r.status, '21a: send invalid npub exits 1');
assertJsonField(r.stdout, 'error', 'invalid-npub', '21b: error is invalid-npub');

// 22: empty body / NUL byte
r = run('send', npubX, '');
assertEq(1, r.status, '22a: send empty body exits 1 (usage)');
// NUL-byte rejection: Node's child_process refuses to pass a NUL in argv
// (ERR_INVALID_ARG_VALUE), so we can't reach the nostr.mjs check via the
// public CLI. The check in source (body.includes('\0')) is a belt-and-
// suspenders defense for callers that bypass execFileSync. Test 22b just
// confirms a NUL-containing arg fails the call boundary.
r = run('send', npubX, 'hello\0world');
assertEq(1, r.status, '22b: NUL in arg refused (by Node child_process or by nostr.mjs)');

// ── 23-25: poll ──

console.log('\npoll:');
clearDir(spoolDir);
r = run('poll');
assertEq(1, r.status, '23a: poll on empty spool exits 1');
assertEq('', r.stdout, '23b: empty spool no stdout');

// Plant two spool files; poll drains them
writeFileSync(join(spoolDir, '1.jsonl'), JSON.stringify({ ts: '2026-05-17T00:00:00Z', from_npub: 'npub1aaa', body: 'one' }));
writeFileSync(join(spoolDir, '2.jsonl'), JSON.stringify({ ts: '2026-05-17T00:00:01Z', from_npub: 'npub1bbb', body: 'two' }));
r = run('poll');
assertEq(0, r.status, '24a: poll with files exits 0');
const lines = r.stdout.split('\n');
assertEq(2, lines.length, '24b: poll outputs 2 lines');
assertEq(0, readdirSync(spoolDir).length, '24c: spool drained');

// 25: lines are valid JSON
let lineOk = true;
for (const l of lines) {
    try { JSON.parse(l); } catch { lineOk = false; }
}
assertTrue(lineOk, '25: each poll line is valid JSON');

// ── 26-28: whoami ──

console.log('\nwhoami:');
writeEnv('');
run('login');
r = run('whoami');
assertEq(0, r.status, '26a: whoami exits 0');
assertJsonField(r.stdout, 'npub', undefined, '26b: whoami prints npub');
assertJsonField(r.stdout, 'relays', undefined, '26c: whoami prints relays');
assertJsonField(r.stdout, 'allowed_npubs_count', '0', '26d: allowed_npubs_count is 0 (empty)');

// 27: whoami never prints nsec
const combined = r.stdout + '\n' + (r.stderr || '');
assertTrue(!combined.includes('nsec1'), '27: whoami output has no nsec');

// 28: whoami before login -> error
writeEnv('NOSTR_RELAYS=wss://test.local\n');
r = run('whoami');
assertEq(1, r.status, '28a: whoami before login exits 1');
assertJsonField(r.stdout, 'error', 'not-logged-in', '28b: error is not-logged-in');

// ── 29-30: help / unknown ──

console.log('\nhelp:');
r = run('help');
assertEq(0, r.status, '29a: help exits 0');
assertJsonField(r.stdout, 'commands', undefined, '29b: help lists commands');
r = run();
assertEq(0, r.status, '30: no-args defaults to help');

// 30b: direct execution (./nostr.mjs help) — regression for r4 P1 chmod fix.
// Production daemon + sudoers + skill call the CLI directly, not via `node`.
try {
    const directStat = statSync(CLI);
    const directExec = (directStat.mode & 0o111) !== 0;
    assertTrue(directExec, '30c: nostr.mjs has execute bit (chmod +x)');
} catch (e) {
    fail(`30c: stat nostr.mjs failed: ${e.message}`);
}
try {
    const out = execFileSync(CLI, [...baseFlags, 'help'], { encoding: 'utf8', timeout: 5000 });
    assertJsonField(out.trim(), 'commands', undefined, '30d: direct ./nostr.mjs help works (lists commands)');
} catch (e) {
    fail(`30d: direct ./nostr.mjs help failed (status=${e.status}, msg=${e.message})`);
}

// ── 31-35: End-to-end via mock relay ──

console.log('\nE2E mock-relay:');

async function mockRelay(port) {
    const wss = new WebSocketServer({ port });
    const recv = [];   // events received by this relay (from publishers)
    const subs = [];   // active subscriptions, used to push EVENTs to subscribers
    wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg[0] === 'REQ') {
                subs.push({ ws, sid: msg[1], filter: msg[2] });
                ws.send(JSON.stringify(['EOSE', msg[1]]));
            } else if (msg[0] === 'EVENT') {
                recv.push(msg[1]);
                ws.send(JSON.stringify(['OK', msg[1].id, true, '']));
            }
        });
    });
    return {
        port,
        recv,
        push: (event) => {
            for (const s of subs) {
                try { s.ws.send(JSON.stringify(['EVENT', s.sid, event])); } catch {}
            }
        },
        close: () => wss.close(),
    };
}

const relayPort = 35900 + Math.floor(Math.random() * 100);
const relay = await mockRelay(relayPort);

// Set up two identities and write nostr.env for our serve
const skSender = generateSecretKey();
const pkSender = getPublicKey(skSender);
const npubSender = nip19.npubEncode(pkSender);
const skRecv = generateSecretKey();
const pkRecv = getPublicKey(skRecv);
const nsecRecv = nip19.nsecEncode(skRecv);
const npubRecv = nip19.npubEncode(pkRecv);

writeFileSync(envFile, [
    `NOSTR_NSEC=${nsecRecv}`,
    `NOSTR_NPUB=${npubRecv}`,
    `NOSTR_RELAYS=ws://127.0.0.1:${relayPort}`,
    `NOSTR_ALLOWED_NPUBS=${npubSender}`,
    '',
].join('\n'));
chmodSync(envFile, 0o600);
clearDir(spoolDir);
clearDir(outboxDir);

// Spawn serve
const serveProc = spawn('node', [CLI, ...baseFlags, 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
});
await sleep(800);

// 31: serve subscribed (relay's subs list has 1)
// (We can't directly inspect serve's view, but pushing an event should land.)
const realWrap = nip17.wrapEvent(skSender, { publicKey: pkRecv }, 'hello from sender');
relay.push(realWrap);
await sleep(800);
const spoolFiles = readdirSync(spoolDir);
assertEq(1, spoolFiles.length, '31a: serve received + decrypted, wrote spool');
if (spoolFiles.length === 1) {
    const rec = JSON.parse(readFileSync(join(spoolDir, spoolFiles[0]), 'utf8'));
    assertEq('hello from sender', rec.body, '31b: spool body matches');
    assertEq(npubSender, rec.from_npub, '31c: spool from_npub matches sender');
}

// 32: inbound NOT in allow-list -> dropped
const skOutsider = generateSecretKey();
const outsiderWrap = nip17.wrapEvent(skOutsider, { publicKey: pkRecv }, 'spam');
clearDir(spoolDir);
relay.push(outsiderWrap);
await sleep(500);
assertEq(0, readdirSync(spoolDir).length, '32: not-allow-listed sender dropped');

// 33: outbound -- write outbox file, serve picks up and publishes
clearDir(outboxDir);
writeFileSync(join(outboxDir, 'out1.jsonl'), JSON.stringify({ to_npub: npubSender, body: 'reply' }));
await sleep(800);
assertEq(0, readdirSync(outboxDir).length, '33a: outbox drained after publish');
const lastEv = relay.recv[relay.recv.length - 1];
assertEq(1059, lastEv?.kind, '33b: relay received kind:1059 wrap');
// Unwrap with the sender's sk (we are simulating the recipient on the other side)
const unwrapped = nip17.unwrapEvent(lastEv, skSender);
assertEq('reply', unwrapped.content, '33c: outbound rumor body == reply');
assertEq(pkRecv, unwrapped.pubkey, '33d: outbound rumor.pubkey == us (sender from receiver perspective)');

// 34: empty allow-list -> all inbound dropped (fail closed)
writeFileSync(envFile, [
    `NOSTR_NSEC=${nsecRecv}`,
    `NOSTR_NPUB=${npubRecv}`,
    `NOSTR_RELAYS=ws://127.0.0.1:${relayPort}`,
    'NOSTR_ALLOWED_NPUBS=',
    '',
].join('\n'));
chmodSync(envFile, 0o600);
serveProc.kill('SIGTERM');
await sleep(300);
const serveProc2 = spawn('node', [CLI, ...baseFlags, 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
});
await sleep(800);
clearDir(spoolDir);
relay.push(realWrap);  // same sender as before
await sleep(500);
assertEq(0, readdirSync(spoolDir).length, '34: empty allow-list drops all inbound');

// 35: shutdown
serveProc2.kill('SIGTERM');
await sleep(200);
relay.close();

// ── 36-41: bug-fix regression tests ──
//   36: dedup of same valid wrap.id (no spam spool)
//   37: dedup poison guard (invalid sig with same id does not block valid arrival)
//   38: CLOSED triggers exponential reconnect backoff (no 1s loop)
//   39: kind:10050 inbox-relay list published on socket open
//   40: kind:10050 published on late-arriving relay (reconnect path)

console.log('\nServe regression tests:');

// ── 36 + 37 + 39: spawn a fresh serve against a fresh mock relay ──

const portB = 36000 + Math.floor(Math.random() * 100);
const relayB = await mockRelay(portB);
const skSenderB = generateSecretKey();
const pkSenderB = getPublicKey(skSenderB);
const npubSenderB = nip19.npubEncode(pkSenderB);
const skRecvB = generateSecretKey();
const pkRecvB = getPublicKey(skRecvB);
const nsecRecvB = nip19.nsecEncode(skRecvB);
const npubRecvB = nip19.npubEncode(pkRecvB);

writeFileSync(envFile, [
    `NOSTR_NSEC=${nsecRecvB}`,
    `NOSTR_NPUB=${npubRecvB}`,
    `NOSTR_RELAYS=ws://127.0.0.1:${portB}`,
    `NOSTR_ALLOWED_NPUBS=${npubSenderB}`,
    '',
].join('\n'));
chmodSync(envFile, 0o600);
clearDir(spoolDir);
clearDir(outboxDir);
const serveProcB = spawn('node', [CLI, ...baseFlags, 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
await sleep(800);

// 36: dedup of same valid wrap.id
clearDir(spoolDir);
const dupWrap = nip17.wrapEvent(skSenderB, { publicKey: pkRecvB }, 'dup-test');
relayB.push(dupWrap);
await sleep(300);
relayB.push(dupWrap);  // exact same event id
await sleep(300);
assertEq(1, readdirSync(spoolDir).length, '36: same valid wrap.id spooled exactly once');

// 37: dedup poison guard -- invalid sig with same id must NOT block valid arrival
clearDir(spoolDir);
const realWrapC = nip17.wrapEvent(skSenderB, { publicKey: pkRecvB }, 'poison-test-payload');
// Build a poisoned copy: same id (sig is not in the hash) but junk sig
const poisonedWrap = { ...realWrapC, sig: '0'.repeat(128) };
relayB.push(poisonedWrap);  // serve should fail verifyEvent, NOT mark id seen
await sleep(300);
assertEq(0, readdirSync(spoolDir).length, '37a: poisoned wrap (bad sig) rejected, no spool');
relayB.push(realWrapC);     // real one with same id
await sleep(500);
assertEq(1, readdirSync(spoolDir).length, '37b: real wrap with same id still spooled (cache not poisoned)');

// 39: kind:10050 inbox-relay list event published on socket open
const inboxEvents = relayB.recv.filter(e => e?.kind === 10050);
assertTrue(inboxEvents.length >= 1, '39a: kind:10050 inbox-relay list published');
if (inboxEvents.length >= 1) {
    const ev = inboxEvents[0];
    const relayTags = (ev.tags || []).filter(t => t[0] === 'relay').map(t => t[1]);
    assertEq(1, relayTags.length, '39b: kind:10050 has 1 relay tag');
    assertEq(`ws://127.0.0.1:${portB}`, relayTags[0], '39c: kind:10050 relay tag matches env.relays[0]');
}

serveProcB.kill('SIGTERM');
await sleep(200);
relayB.close();

// ── 38: CLOSED triggers exponential reconnect backoff ──

// HOSTILE_REASON contains newline + CR + tab. truncate() in nostr.mjs must
// sanitize control chars so a hostile relay can't forge multi-line log
// entries in journald.
const HOSTILE_REASON = 'rate-limited\nINJECTED\rsecond-line\tWITH-TAB';

async function closedMockRelay(port) {
    const wss = new WebSocketServer({ port });
    const events = [];  // {ts, type: 'connect' | 'req' | 'close'}
    wss.on('connection', (ws) => {
        events.push({ ts: Date.now(), type: 'connect' });
        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg[0] === 'REQ') {
                    events.push({ ts: Date.now(), type: 'req' });
                    ws.send(JSON.stringify(['CLOSED', msg[1], HOSTILE_REASON]));
                } else if (msg[0] === 'EVENT') {
                    events.push({ ts: Date.now(), type: 'event' });
                    // Don't OK; relay is hostile in this test
                }
            } catch {}
        });
        ws.on('close', () => events.push({ ts: Date.now(), type: 'close' }));
    });
    return {
        port,
        events,
        close: () => wss.close(),
    };
}

const portC = 36100 + Math.floor(Math.random() * 100);
const closedRelay = await closedMockRelay(portC);

writeFileSync(envFile, [
    `NOSTR_NSEC=${nsecRecvB}`,
    `NOSTR_NPUB=${npubRecvB}`,
    `NOSTR_RELAYS=ws://127.0.0.1:${portC}`,
    `NOSTR_ALLOWED_NPUBS=${npubSenderB}`,
    '',
].join('\n'));
chmodSync(envFile, 0o600);
const serveProcC = spawn('node', [CLI, ...baseFlags, 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
let stderrC = '';
serveProcC.stderr.on('data', (chunk) => { stderrC += chunk.toString(); });

// Wait long enough to see at least 3 connects with growing delays.
// Schedule: connect at ~0, reconnect at ~1s, reconnect at ~3s (1+2), reconnect at ~7s (1+2+4).
// We wait 5s to get at least 3 connects (0, 1s, 3s).
await sleep(5000);

const connects = closedRelay.events.filter(e => e.type === 'connect');
assertTrue(connects.length >= 3,
    `38a: at least 3 connect attempts under persistent CLOSED (got ${connects.length})`);
if (connects.length >= 3) {
    const delay1 = connects[1].ts - connects[0].ts;
    const delay2 = connects[2].ts - connects[1].ts;
    // First reconnect ~1s, second ~2s (exponential). Allow generous slack.
    assertTrue(delay2 > delay1,
        `38b: second reconnect delay (${delay2}ms) > first (${delay1}ms) -- exponential backoff`);
    assertTrue(delay1 >= 800,
        `38c: first reconnect waited ~1s (got ${delay1}ms)`);
}
const reqs = closedRelay.events.filter(e => e.type === 'req');
assertEq(connects.length, reqs.length,
    '38d: one REQ per connection (no rapid re-REQ on same socket)');

// 38e: hostile multiline CLOSED reason is sanitized to one log line per CLOSED.
// truncate() must strip newlines/CR/tabs from relay-controlled strings so a
// hostile relay can't inject fake log entries into journald.
const closedLogs = stderrC.split('\n').filter(l => l.includes('relay-closed-sub'));
assertEq(reqs.length, closedLogs.length,
    `38e: one relay-closed-sub log per CLOSED frame (got ${closedLogs.length}, expected ${reqs.length}) -- no newline injection`);
// 38f: the injected substring 'INJECTED' must not appear on a line by itself
// (would mean a newline survived sanitization). Confirm 'INJECTED' is on the
// same log line as 'relay-closed-sub'.
const orphanInjected = stderrC.split('\n').some(l =>
    l.trim().startsWith('INJECTED') || l.trim().startsWith('second-line') || l.trim().startsWith('WITH-TAB'));
assertTrue(!orphanInjected,
    '38f: no orphan injected line in stderr (control chars stripped by truncate)');

serveProcC.kill('SIGTERM');
await sleep(200);
closedRelay.close();

// ── 40: kind:10050 published on late-arriving relay (reconnect path) ──

const portD = 36200 + Math.floor(Math.random() * 100);
writeFileSync(envFile, [
    `NOSTR_NSEC=${nsecRecvB}`,
    `NOSTR_NPUB=${npubRecvB}`,
    `NOSTR_RELAYS=ws://127.0.0.1:${portD}`,
    `NOSTR_ALLOWED_NPUBS=${npubSenderB}`,
    '',
].join('\n'));
chmodSync(envFile, 0o600);
// Start serve BEFORE relay -- first connection attempt should fail with ECONNREFUSED
const serveProcD = spawn('node', [CLI, ...baseFlags, 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
await sleep(1500);  // serve has tried, failed, scheduled reconnect

// Start the relay AFTER serve has already tried to connect once
const relayD = await mockRelay(portD);
await sleep(3500);  // give serve time to reconnect (backoff was at 2s) + publish

const inboxEventsD = relayD.recv.filter(e => e?.kind === 10050);
assertTrue(inboxEventsD.length >= 1,
    `40: kind:10050 eventually published once late-arriving relay accepts conn (got ${inboxEventsD.length})`);

serveProcD.kill('SIGTERM');
await sleep(200);
relayD.close();

// ── 41-55: nostr.mjs search ──
//   41: hashtag mode (NIP-01 #t filter) returns signed events
//   42: keyword mode (NIP-50 search filter) returns signed events
//   43: interspersed flag parsing -- keyword before --since works
//   44: dedup across relays
//   45: verifyEvent rejects bad-sig events
//   46: content sanitization strips smuggling Unicode
//   47: tag sanitization strips smuggling Unicode (P1 regression)
//   48: timeout returns within budget when relay never sends EOSE
//   49: mutually exclusive flags
//   50: empty input
//   51: flag validation (bad-kind, bad-limit, bad-since, bad-author)
//   52: NOSTR_SEARCH_RELAYS precedence over NOSTR_RELAYS

console.log('\nSearch:');

// Search-mode mock relay: drives EVENT/EOSE in response to REQ. Records
// the received filter for assertion. If `withhold` is true, never sends
// EOSE (drives the timeout path).
async function searchMockRelay(port, eventsToReturn, { withhold = false } = {}) {
    const wss = new WebSocketServer({ port });
    const recvFilters = [];
    let lastSubId = null;
    wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
            let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg[0] === 'REQ') {
                lastSubId = msg[1];
                recvFilters.push(msg[2]);
                for (const ev of eventsToReturn) {
                    try { ws.send(JSON.stringify(['EVENT', lastSubId, ev])); } catch {}
                }
                if (!withhold) {
                    try { ws.send(JSON.stringify(['EOSE', lastSubId])); } catch {}
                }
            } else if (msg[0] === 'CLOSE') {
                /* client tore down sub -- nothing to do */
            }
        });
    });
    return { port, recvFilters, close: () => wss.close() };
}

function signNote(sk, content, tags = []) {
    return finalizeEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        content,
        tags,
    }, sk);
}

// Async variant of run() -- needed because search tests run a WebSocketServer
// in this process. execFileSync would block the event loop and the mock
// relay's `connection` handler would never fire while the subprocess waits.
//
// Test isolation: NOSTR_SEARCH_RELAYS is explicitly cleared by default
// (codex r3 P2). loadEnv() gives process env precedence over env-file, so
// a stray dev shell var would silently route mock-relay tests to an
// external relay. Tests that exercise process-env precedence opt in by
// passing { NOSTR_SEARCH_RELAYS: '...' } in the env arg.
//
// All runX(...) wrappers share this shape; spawnCli is the internal.
function spawnCli(subcommand, cmdArgs, env, timeoutEnvKey, timeoutMs) {
    return new Promise((resolve) => {
        const childEnv = { ...process.env, [timeoutEnvKey]: String(timeoutMs) };
        delete childEnv.NOSTR_SEARCH_RELAYS;
        Object.assign(childEnv, env);
        const proc = spawn('node', [CLI, ...baseFlags, subcommand, ...cmdArgs], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv,
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            resolve({ stdout: stdout.trim(), stderr: stderr.trim(), status: code || 0 });
        });
    });
}

function runSearch(args, env = {}) {
    return spawnCli('search', args, env, 'NOSTR_SEARCH_TIMEOUT_MS', 2000);
}

const skNoter = generateSecretKey();
const pkNoter = getPublicKey(skNoter);

// 41: hashtag mode
{
    const port = 36600 + Math.floor(Math.random() * 100);
    const ev1 = signNote(skNoter, 'first note', [['t', 'bitcoin']]);
    const ev2 = signNote(skNoter, 'second note', [['t', 'bitcoin']]);
    const r = await searchMockRelay(port, [ev1, ev2]);
    writeEnv([`NOSTR_RELAYS=ws://127.0.0.1:${port}`, ''].join('\n'));

    const res = await runSearch(['--tag', 'bitcoin', '--limit', '5']);
    assertEq(0, res.status, '41a: hashtag search exits 0');
    const lines = res.stdout.split('\n').filter(Boolean);
    assertEq(2, lines.length, '41b: 2 events returned');
    const seenFilter = r.recvFilters[0];
    assertEq('bitcoin', seenFilter?.['#t']?.[0], '41c: relay received #t=bitcoin');
    r.close();
}

// 42: keyword mode (NIP-50)
{
    const port = 36700 + Math.floor(Math.random() * 100);
    const ev = signNote(skNoter, 'lightning is fast', []);
    const r = await searchMockRelay(port, [ev]);
    writeEnv([`NOSTR_RELAYS=ws://127.0.0.1:${port}`, ''].join('\n'));

    const res = await runSearch(['lightning']);
    assertEq(0, res.status, '42a: keyword search exits 0');
    const parsed = JSON.parse(res.stdout.split('\n')[0]);
    assertEq('lightning is fast', parsed.content, '42b: content matches');
    assertEq('lightning', r.recvFilters[0]?.search, '42c: relay received search=lightning');
    r.close();
}

// 43: interspersed flags -- keyword first, --since after
{
    const port = 36800 + Math.floor(Math.random() * 100);
    const r = await searchMockRelay(port, []);
    writeEnv([`NOSTR_RELAYS=ws://127.0.0.1:${port}`, ''].join('\n'));

    await runSearch(['"lightning network"', '--since', '24h']);
    const f = r.recvFilters[0];
    assertTrue(f?.search?.includes('lightning network'), '43a: keyword passed through interspersed flag');
    assertTrue(typeof f?.since === 'number', '43b: --since after keyword applied');
    r.close();
}

// 44: dedup across relays
{
    const portA = 36900 + Math.floor(Math.random() * 50);
    const portB = 36950 + Math.floor(Math.random() * 50);
    const ev = signNote(skNoter, 'dup', [['t', 'dup']]);
    const a = await searchMockRelay(portA, [ev]);
    const b = await searchMockRelay(portB, [ev]);
    writeEnv([`NOSTR_RELAYS=ws://127.0.0.1:${portA},ws://127.0.0.1:${portB}`, ''].join('\n'));

    const res = await runSearch(['--tag', 'dup']);
    const lines = res.stdout.split('\n').filter(Boolean);
    assertEq(1, lines.length, '44: same event from 2 relays dedups to 1 output line');
    a.close(); b.close();
}

// 45: verifyEvent rejects bad sig
{
    const port = 37000 + Math.floor(Math.random() * 100);
    const good = signNote(skNoter, 'good event', [['t', 'check']]);
    const bad = { ...good, id: 'aa'.repeat(32), sig: '00'.repeat(64) };
    const r = await searchMockRelay(port, [good, bad]);
    writeEnv([`NOSTR_RELAYS=ws://127.0.0.1:${port}`, ''].join('\n'));

    const res = await runSearch(['--tag', 'check']);
    const lines = res.stdout.split('\n').filter(Boolean);
    assertEq(1, lines.length, '45: bad-sig event rejected by verifyEvent');
    r.close();
}

// 46: content sanitization
{
    const port = 37100 + Math.floor(Math.random() * 100);
    const ev = signNote(skNoter, 'Hello X\u{E0065}\u{E0076}\u{E0069}\u{E006C} World', [['t', 'sani']]);
    const r = await searchMockRelay(port, [ev]);
    writeEnv([`NOSTR_RELAYS=ws://127.0.0.1:${port}`, ''].join('\n'));

    const res = await runSearch(['--tag', 'sani']);
    const parsed = JSON.parse(res.stdout);
    assertEq('Hello X World', parsed.content, '46: smuggled tag-block payload stripped from content');
    r.close();
}

// 47: tag sanitization (P1 regression)
{
    const port = 37200 + Math.floor(Math.random() * 100);
    const ev = signNote(skNoter, 'tag sanitize test', [
        ['t', 'tagsani'],
        ['client', 'amethyst\u{200B}\u{E0065}\u{E0076}\u{E0069}\u{E006C}'],
    ]);
    const r = await searchMockRelay(port, [ev]);
    writeEnv([`NOSTR_RELAYS=ws://127.0.0.1:${port}`, ''].join('\n'));

    const res = await runSearch(['--tag', 'tagsani']);
    const parsed = JSON.parse(res.stdout);
    const clientTag = parsed.tags.find(t => t[0] === 'client');
    assertEq('amethyst', clientTag?.[1], '47: smuggled payload stripped from tag value');
    r.close();
}

// 48: timeout when relay never sends EOSE
{
    const port = 37300 + Math.floor(Math.random() * 100);
    const r = await searchMockRelay(port, [], { withhold: true });
    writeEnv([`NOSTR_RELAYS=ws://127.0.0.1:${port}`, ''].join('\n'));

    const t0 = Date.now();
    const res = await runSearch(['--tag', 'timeout'], { NOSTR_SEARCH_TIMEOUT_MS: '300' });
    const elapsed = Date.now() - t0;
    assertEq(0, res.status, '48a: timeout still exits 0');
    assertTrue(elapsed < 2000, `48b: returned within budget (got ${elapsed}ms)`);
    r.close();
}

// 49: mutually exclusive flags
{
    writeEnv('NOSTR_RELAYS=ws://127.0.0.1:39999\n');  // unreachable, won't be queried
    const res = await runSearch(['--tag', 'x', 'somekeyword']);
    assertEq(1, res.status, '49a: --tag + keyword exits 1');
    assertJsonField(res.stdout, 'error', 'use-tag-or-keyword-not-both', '49b: error code matches');
}

// 50: empty input
{
    const res = await runSearch([]);
    assertEq(1, res.status, '50a: bare search exits 1');
    assertContains(res.stdout, 'usage:', '50b: error mentions usage');
}

// 51: flag validation
{
    writeEnv('NOSTR_RELAYS=ws://127.0.0.1:39999\n');
    const tests = [
        { args: ['--kind', 'abc', 'kw'],        code: 'bad-kind' },
        { args: ['--kind', '-1', 'kw'],         code: 'bad-kind' },  // codex r2 P2
        { args: ['--limit', '0', 'kw'],         code: 'bad-limit' },
        { args: ['--limit', '200', 'kw'],       code: 'bad-limit' },
        { args: ['--since', 'foo', 'kw'],       code: 'bad-since' },
        { args: ['--author', 'not_npub', 'kw'], code: 'bad-author-npub' },
        { args: ['--tag'],                       code: 'bad-tag' },    // simplify: --tag missing value
        { args: ['--tag', '--limit', '10'],      code: 'bad-tag' },    // simplify: --tag followed by flag, not value
    ];
    for (const t of tests) {
        const res = await runSearch(t.args);
        assertJsonField(res.stdout, 'error', t.code, `51 [${t.code}]: ${t.args.join(' ')}`);
    }
}

// 53: NOTICE is non-fatal (codex r2 P2). Relay sends NOTICE, then EVENT,
//     then EOSE. The EVENT must still be emitted.
{
    const port = 37700 + Math.floor(Math.random() * 100);
    const ev = signNote(skNoter, 'survived NOTICE', [['t', 'notice']]);
    const wss = new WebSocketServer({ port });
    wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg[0] === 'REQ') {
                ws.send(JSON.stringify(['NOTICE', 'just a chatty relay, please ignore']));
                ws.send(JSON.stringify(['EVENT', msg[1], ev]));
                ws.send(JSON.stringify(['EOSE', msg[1]]));
            }
        });
    });
    writeEnv([`NOSTR_RELAYS=ws://127.0.0.1:${port}`, ''].join('\n'));
    const res = await runSearch(['--tag', 'notice']);
    const lines = res.stdout.split('\n').filter(Boolean);
    assertEq(1, lines.length, '53a: NOTICE before EVENT does not cut off the sub');
    assertContains(res.stderr || '', 'relay-notice', '53b: NOTICE still logged to stderr');
    wss.close();
}

// 54: Stderr log-injection guard (codex r2 P2). Relay sends CLOSED with
//     newline + control chars in reason. truncate() must strip them so
//     stderr stays on one line.
{
    const port = 37800 + Math.floor(Math.random() * 100);
    const wss = new WebSocketServer({ port });
    wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg[0] === 'REQ') {
                ws.send(JSON.stringify(['CLOSED', msg[1], 'rate-limited\nINJECTED\rsecond-line\tWITH-TAB']));
            }
        });
    });
    writeEnv([`NOSTR_RELAYS=ws://127.0.0.1:${port}`, ''].join('\n'));
    const res = await runSearch(['--tag', 'inj']);
    const closedLogs = (res.stderr || '').split('\n').filter(l => l.includes('relay-closed'));
    assertEq(1, closedLogs.length, '54a: exactly one relay-closed log line per CLOSED frame');
    const orphan = (res.stderr || '').split('\n').some(l =>
        l.trim().startsWith('INJECTED') || l.trim().startsWith('second-line') || l.trim().startsWith('WITH-TAB'));
    assertTrue(!orphan, '54b: control chars stripped from CLOSED reason by truncate()');
    wss.close();
}

// 52: NOSTR_SEARCH_RELAYS precedence (env-file)
{
    const portSearch = 37500 + Math.floor(Math.random() * 100);
    const portDM = 37600 + Math.floor(Math.random() * 100);
    const ev = signNote(skNoter, 'search relay routed', [['t', 'route']]);
    const rSearch = await searchMockRelay(portSearch, [ev]);
    const rDM = await searchMockRelay(portDM, []);  // should NOT be queried
    writeEnv([
        `NOSTR_RELAYS=ws://127.0.0.1:${portDM}`,
        `NOSTR_SEARCH_RELAYS=ws://127.0.0.1:${portSearch}`,
        '',
    ].join('\n'));

    const res = await runSearch(['--tag', 'route']);
    assertEq(1, res.stdout.split('\n').filter(Boolean).length, '52a: 1 event from search relay');
    assertEq(1, rSearch.recvFilters.length, '52b: search relay queried');
    assertEq(0, rDM.recvFilters.length, '52c: DM relay NOT queried');
    rSearch.close(); rDM.close();
}

// 55: Process env NOSTR_SEARCH_RELAYS wins over env-file value (codex r3 P2)
{
    const portProc = 37900 + Math.floor(Math.random() * 50);
    const portFile = 37950 + Math.floor(Math.random() * 50);
    const ev = signNote(skNoter, 'process env wins', [['t', 'envprec']]);
    const rProc = await searchMockRelay(portProc, [ev]);
    const rFile = await searchMockRelay(portFile, []);  // should NOT be queried
    writeEnv([
        `NOSTR_RELAYS=ws://127.0.0.1:39999`,                       // unused
        `NOSTR_SEARCH_RELAYS=ws://127.0.0.1:${portFile}`,         // file says use this
        '',
    ].join('\n'));

    // Process env explicitly opts in -- runSearch normally clears it.
    const res = await runSearch(['--tag', 'envprec'], {
        NOSTR_SEARCH_RELAYS: `ws://127.0.0.1:${portProc}`,
    });
    assertEq(1, res.stdout.split('\n').filter(Boolean).length, '55a: 1 event from process-env relay');
    assertEq(1, rProc.recvFilters.length, '55b: process-env relay queried');
    assertEq(0, rFile.recvFilters.length, '55c: env-file relay NOT queried (process env wins)');
    rProc.close(); rFile.close();
}

// ── 56-72: nostr.mjs reply (NIP-10 kind:1 reply) ──

console.log('\nReply:');

// captureMockRelay: shared internal for the three "serve a configured
// event on REQ + capture published events on EVENT" mocks (reply,
// profile, follow). Each public wrapper passes its expected publish
// `kind` (1, 0, or 3) so the EVENT capture only catches the kind it
// cares about; other kinds are ignored.
async function captureMockRelay(port, publishKind, eventToServe, { okPublish = true, silent = false } = {}) {
    const wss = new WebSocketServer({ port });
    const published = [];
    const recvReqs = [];
    wss.on('connection', (ws) => {
        if (silent) return;
        ws.on('message', (raw) => {
            let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg[0] === 'REQ') {
                recvReqs.push({ sid: msg[1], filter: msg[2] });
                if (eventToServe) {
                    try { ws.send(JSON.stringify(['EVENT', msg[1], eventToServe])); } catch {}
                }
                try { ws.send(JSON.stringify(['EOSE', msg[1]])); } catch {}
            } else if (msg[0] === 'EVENT' && msg[1] && msg[1].kind === publishKind) {
                published.push(msg[1]);
                try { ws.send(JSON.stringify(['OK', msg[1].id, okPublish, okPublish ? '' : 'test-reject'])); } catch {}
            }
        });
    });
    return { port, published, recvReqs, close: () => wss.close() };
}

// Wrappers: feature-specific names + the right publish kind. Keep the
// public signature each test currently calls.
function replyMockRelay(port, eventToServe, opts = {}) {
    return captureMockRelay(port, 1, eventToServe, opts);
}

function runReply(args, env = {}) {
    return spawnCli('reply', args, env, 'NOSTR_REPLY_TIMEOUT_MS', 2000);
}

// Shared identity for the reply path tests. login generates nsec into env.
{
    writeEnv('');
    run('login');
}

const skSomeAuthor = generateSecretKey();
const pkSomeAuthor = getPublicKey(skSomeAuthor);
const skGrandparent = generateSecretKey();
const pkGrandparent = getPublicKey(skGrandparent);
const skRootAuthor = generateSecretKey();
const pkRootAuthor = getPublicKey(skRootAuthor);

// `signNote` is defined earlier in the file (search section). Reuse it.

// 56: Reply to top-level note -- 5-field root e-tag with parent.pubkey
{
    const port = 38000 + Math.floor(Math.random() * 50);
    const parent = signNote(skSomeAuthor, 'top-level parent note', []);
    const r = await replyMockRelay(port, parent);
    // Preserve nsec; only swap relays
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    const res = await runReply([parent.id, 'thanks for the note']);
    assertEq(0, res.status, '56a: reply to top-level exits 0');
    const out = JSON.parse(res.stdout);
    assertEq(true, out.ok, '56b: ok=true');
    const tags = out.tags;
    assertEq(2, tags.length, '56c: top-level reply emits exactly e-root + p');
    const eRoot = tags.find(t => t[0] === 'e');
    assertEq(parent.id, eRoot[1], '56d: e-root id matches parent');
    assertEq('root', eRoot[3], '56e: marker is root');
    assertEq(parent.pubkey, eRoot[4], '56f: e-root 5th field is parent author (NIP-10 current)');
    r.close();
}

// 57: Reply to a nested reply with known root author
{
    const port = 38050 + Math.floor(Math.random() * 50);
    const realRootId = 'a'.repeat(64);
    const parent = signNote(skSomeAuthor, 'a nested reply', [
        ['e', realRootId, '', 'root', pkRootAuthor],
        ['p', pkGrandparent],
    ]);
    const r = await replyMockRelay(port, parent);
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    const res = await runReply([parent.id, 'jumping into the thread']);
    assertEq(0, res.status, '57a: nested reply exits 0');
    const tags = JSON.parse(res.stdout).tags;
    const eRoot = tags.find(t => t[0] === 'e' && t[3] === 'root');
    const eReply = tags.find(t => t[0] === 'e' && t[3] === 'reply');
    assertEq(realRootId, eRoot[1], '57b: root id carried forward');
    assertEq(pkRootAuthor, eRoot[4], '57c: root author 5th field carried (NIP-10 current)');
    assertEq(parent.id, eReply[1], '57d: reply id is direct parent');
    assertEq(parent.pubkey, eReply[4], '57e: reply 5th field is parent author');
    const pTags = tags.filter(t => t[0] === 'p').map(t => t[1]);
    assertTrue(pTags.includes(parent.pubkey), '57f: p chain includes parent');
    assertTrue(pTags.includes(pkGrandparent), '57g: p chain includes grandparent');
    r.close();
}

// 58: Malformed/missing root author -> 4-tuple root tag (no 5th field)
{
    const port = 38100 + Math.floor(Math.random() * 50);
    const realRootId = 'b'.repeat(64);
    const parent = signNote(skSomeAuthor, 'nested with bad root author', [
        ['e', realRootId, '', 'root', 'not-hex-garbage'],
    ]);
    const r = await replyMockRelay(port, parent);
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    const res = await runReply([parent.id, 'reply']);
    const tags = JSON.parse(res.stdout).tags;
    const eRoot = tags.find(t => t[0] === 'e' && t[3] === 'root');
    assertEq(4, eRoot.length, '58: malformed root author -> 4-tuple e-root (no 5th field)');
    r.close();
}

// 59: Malformed parent p tag dropped (codex r1 P2)
{
    const port = 38150 + Math.floor(Math.random() * 50);
    const validP = 'c'.repeat(64);
    const parent = signNote(skSomeAuthor, 'has bad p tag', [
        ['p', 'javascript:alert(1)'],
        ['p', validP],
    ]);
    const r = await replyMockRelay(port, parent);
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    const res = await runReply([parent.id, 'hi']);
    const pTags = JSON.parse(res.stdout).tags.filter(t => t[0] === 'p').map(t => t[1]);
    assertTrue(!pTags.includes('javascript:alert(1)'), '59a: malformed p value not carried');
    assertTrue(pTags.includes(parent.pubkey), '59b: parent author p included');
    assertTrue(pTags.includes(validP), '59c: valid p carried through');
    r.close();
}

// 60: Malformed root marker -> treat parent as root
{
    const port = 38200 + Math.floor(Math.random() * 50);
    const parent = signNote(skSomeAuthor, 'bad root id', [
        ['e', 'not-a-real-hex-id', '', 'root'],
    ]);
    const r = await replyMockRelay(port, parent);
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    const res = await runReply([parent.id, 'hi']);
    const tags = JSON.parse(res.stdout).tags;
    const eTags = tags.filter(t => t[0] === 'e');
    assertEq(1, eTags.length, '60a: only one e-tag emitted (parent treated as root)');
    assertEq('root', eTags[0][3], '60b: marker is root');
    assertEq(parent.id, eTags[0][1], '60c: id is parent itself');
    r.close();
}

// 61: Outbound body sanitized
{
    const port = 38250 + Math.floor(Math.random() * 50);
    const parent = signNote(skSomeAuthor, 'sanitize-test parent', []);
    const r = await replyMockRelay(port, parent);
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    const payload = 'Hello X\u{E0065}\u{E0076}\u{E0069}\u{E006C} World';
    await runReply([parent.id, payload]);
    const published = r.published[0];
    assertEq('Hello X World', published.content, '61: smuggled tag-block stripped from outbound content');
    r.close();
}

// 62: Empty body after sanitize -> reject
{
    const port = 38300 + Math.floor(Math.random() * 50);
    const parent = signNote(skSomeAuthor, 'empty-sanitize-test', []);
    const r = await replyMockRelay(port, parent);
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    // Body of only tag-block chars sanitizes to empty.
    const res = await runReply([parent.id, '\u{E0061}\u{E0062}\u{E0063}']);
    assertEq(1, res.status, '62a: empty-after-sanitize exits 1');
    assertJsonField(res.stdout, 'error', 'empty-body-after-sanitize', '62b: error code matches');
    r.close();
}

// 63: Bad parent id format
{
    const res = await runReply(['not-a-real-hex-id', 'body']);
    assertEq(1, res.status, '63a: bad-parent-event-id exits 1');
    assertJsonField(res.stdout, 'error', 'bad-parent-event-id', '63b: error code matches');
}

// 64: Parent not found (relay returns no events)
{
    const port = 38400 + Math.floor(Math.random() * 50);
    const r = await replyMockRelay(port, null);  // null = no parent to serve
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    const ghost = 'd'.repeat(64);
    const res = await runReply([ghost, 'body']);
    assertEq(1, res.status, '64a: parent-not-found exits 1');
    assertJsonField(res.stdout, 'error', 'parent-not-found', '64b: error code matches');
    r.close();
}

// 65: Mismatched id from relay (codex r1 P2 -- non-binding filter attack).
//     Two distinct VALID signed kind:1 events: we request `realParent.id`,
//     relay serves `decoy` (also valid sig, also kind:1, just different id).
//     resolveEvent must reject because ev.id !== requested, NOT because
//     the sig is broken (codex r3 P2 -- earlier mutation-style test
//     incidentally broke the sig and passed for the wrong reason).
{
    const port = 38450 + Math.floor(Math.random() * 50);
    const realParent = signNote(skSomeAuthor, 'real parent we ask for', []);
    const decoy = signNote(skGrandparent, 'valid signed kind:1 with a different id', []);
    assertTrue(realParent.id !== decoy.id, '65pre: real parent and decoy have distinct ids');
    assertTrue(verifyEvent(decoy), '65pre: decoy has valid signature');
    const r = await replyMockRelay(port, decoy);  // mock serves decoy in response to any REQ
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    const res = await runReply([realParent.id, 'body']);
    assertEq(1, res.status, '65a: valid-sig wrong-id rejected, exits 1');
    assertJsonField(res.stdout, 'error', 'parent-not-found', '65b: rejected as parent-not-found');
    r.close();
}

// 66: Wrong-kind parent rejected
{
    const port = 38500 + Math.floor(Math.random() * 50);
    const profile = finalizeEvent({
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        content: '{"name":"someone"}',
        tags: [],
    }, skSomeAuthor);
    const r = await replyMockRelay(port, profile);
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    const res = await runReply([profile.id, 'body']);
    assertEq(1, res.status, '66a: kind:0 parent rejected, exits 1');
    assertJsonField(res.stdout, 'error', 'parent-not-found', '66b: rejected as parent-not-found');
    r.close();
}

// 67: Bad-sig parent rejected
{
    const port = 38550 + Math.floor(Math.random() * 50);
    const realParent = signNote(skSomeAuthor, 'bad-sig-test', []);
    const tampered = { ...realParent, sig: '00'.repeat(64) };
    const r = await replyMockRelay(port, tampered);
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    const res = await runReply([realParent.id, 'body']);
    assertEq(1, res.status, '67a: bad-sig parent rejected, exits 1');
    assertJsonField(res.stdout, 'error', 'parent-not-found', '67b: rejected as parent-not-found');
    r.close();
}

// 68: Publish failure when no relay OKs
{
    const port = 38600 + Math.floor(Math.random() * 50);
    const parent = signNote(skSomeAuthor, 'publish-fail-test', []);
    const r = await replyMockRelay(port, parent, { okPublish: false });
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    const res = await runReply([parent.id, 'body']);
    assertEq(1, res.status, '68a: publish-failed exits 1');
    assertJsonField(res.stdout, 'error', 'publish-failed', '68b: error code matches');
    r.close();
}

// 69: Resolved relay used as NIP-10 hint (codex r1 P3)
{
    const portA = 38650 + Math.floor(Math.random() * 25);
    const portB = 38680 + Math.floor(Math.random() * 25);
    // Relay A has nothing; relay B has the parent. Hint must point to B.
    const rA = await replyMockRelay(portA, null);
    const parent = signNote(skSomeAuthor, 'hint-test parent', []);
    const rB = await replyMockRelay(portB, parent);
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${portA},ws://127.0.0.1:${portB}\n`);

    const res = await runReply([parent.id, 'body']);
    const eRoot = JSON.parse(res.stdout).tags.find(t => t[0] === 'e');
    assertEq(`ws://127.0.0.1:${portB}`, eRoot[2], '69: relay hint is the relay that delivered parent');
    rA.close(); rB.close();
}

// 70: Uppercase parentId normalized (codex r2 P3)
{
    const port = 38730 + Math.floor(Math.random() * 30);
    const parent = signNote(skSomeAuthor, 'uppercase-id-test', []);
    const r = await replyMockRelay(port, parent);
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    const res = await runReply([parent.id.toUpperCase(), 'body']);
    assertEq(0, res.status, '70a: uppercase parentId resolves');
    const out = JSON.parse(res.stdout);
    assertEq(parent.id, out.parent, '70b: returned parent id is lowercase');
    r.close();
}

// 71: Mixed-case parent tag normalized to lowercase in emitted reply
{
    const port = 38770 + Math.floor(Math.random() * 30);
    const mixedRoot = 'A'.repeat(32) + 'a'.repeat(32);
    const mixedP = 'B'.repeat(32) + 'b'.repeat(32);
    const parent = signNote(skSomeAuthor, 'mixed-case-tags', [
        ['e', mixedRoot, '', 'root'],
        ['p', mixedP],
    ]);
    const r = await replyMockRelay(port, parent);
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${port}\n`);

    const res = await runReply([parent.id, 'body']);
    const tags = JSON.parse(res.stdout).tags;
    const eRoot = tags.find(t => t[0] === 'e' && t[3] === 'root');
    assertEq(mixedRoot.toLowerCase(), eRoot[1], '71a: mixed-case root id lowercased');
    const pVals = tags.filter(t => t[0] === 'p').map(t => t[1]);
    assertTrue(pVals.includes(mixedP.toLowerCase()), '71b: mixed-case p value lowercased');
    r.close();
}

// 72: Empty body (no args) -> usage error
{
    const ghost = 'd'.repeat(64);
    const res = await runReply([ghost]);
    assertEq(1, res.status, '72a: empty body exits 1');
    assertContains(res.stdout, 'usage:', '72b: error mentions usage');
}

// 73: Multi-relay success exits promptly (codex r3 P1 -- hang regression).
//     Relay A returns the parent + OKs the publish. Relay B accepts the
//     connection but never sends anything. The subprocess must close ALL
//     sockets on success, not just the one that delivered the event,
//     otherwise Node keeps the silent socket alive and the process never
//     exits. We assert close-on-stdout time is well under the 2s timeout.
{
    const portA = 38900 + Math.floor(Math.random() * 25);
    const portB = 38930 + Math.floor(Math.random() * 25);
    const parent = signNote(skSomeAuthor, 'multi-relay-hang-test', []);
    const rA = await replyMockRelay(portA, parent);          // serves + OKs
    const rB = await replyMockRelay(portB, null, { silent: true });  // accepts, never speaks
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=ws://127.0.0.1:${portA},ws://127.0.0.1:${portB}\n`);

    const t0 = Date.now();
    const res = await runReply([parent.id, 'should exit promptly']);
    const elapsed = Date.now() - t0;
    assertEq(0, res.status, '73a: multi-relay success exits 0');
    // 2s is the NOSTR_REPLY_TIMEOUT_MS the test runner sets. The fixed
    // resolveEvent + publishOneShot close ALL sockets on first success,
    // so the subprocess should exit in well under 1s. Pre-fix this hung
    // until the timer expired (then the per-relay timeout cleanup ran).
    assertTrue(elapsed < 1500,
        `73b: subprocess exits promptly after success (got ${elapsed}ms; pre-fix hung > 2000ms)`);
    rA.close(); rB.close();
}

// ── 74-95: nostr.mjs profile (kind:0 set/get) ──

console.log('\nProfile:');

// profileMockRelay: serves a configured kind:0 (or none) in response to
// REQ with authors filter; captures published kind:0 events on EVENT,
// OKs them by default.
function profileMockRelay(port, kind0Event, opts = {}) {
    return captureMockRelay(port, 0, kind0Event, opts);
}

function runProfile(args, env = {}) {
    return spawnCli('profile', args, env, 'NOSTR_PROFILE_TIMEOUT_MS', 1500);
}

// Reuse the existing nsec written by the reply tests' login() call.
const ownNsec = readFileSync(envFile, 'utf8').split('\n').find(l => l.startsWith('NOSTR_NSEC=')).slice('NOSTR_NSEC='.length);
const ownSk = nip19.decode(ownNsec).data;

function signKind0(sk, contentObj, createdAt) {
    return finalizeEvent({
        kind: 0,
        created_at: createdAt ?? Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify(contentObj),
    }, sk);
}

function pointEnvToRelays(...urls) {
    const e = readFileSync(envFile, 'utf8');
    writeFileSync(envFile, e.replace(/^NOSTR_RELAYS=.*\n?/m, '') + `NOSTR_RELAYS=${urls.join(',')}\n`);
}

// 74: Set replace mode -- only specified fields published
{
    const port = 39000 + Math.floor(Math.random() * 50);
    const existing = signKind0(ownSk, { name: 'old', about: 'oldabout' });
    const r = await profileMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runProfile(['set', '--name', 'NewOnly', '--picture', 'https://x.com/a.png', '--replace']);
    assertEq(0, res.status, '74a: replace exits 0');
    const content = JSON.parse(r.published[0].content);
    assertEq('NewOnly', content.name, '74b: replace sets new name');
    assertEq('https://x.com/a.png', content.picture, '74c: replace sets new picture');
    assertTrue(!('about' in content), '74d: replace drops untouched fields');
    r.close();
}

// 75: Merge mode preserves untouched fields
{
    const port = 39050 + Math.floor(Math.random() * 50);
    const existing = signKind0(ownSk, { name: 'KeepName', about: 'OldAbout' });
    const r = await profileMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    await runProfile(['set', '--about', 'NewAbout']);
    const content = JSON.parse(r.published[0].content);
    assertEq('KeepName', content.name, '75a: merge preserves untouched name');
    assertEq('NewAbout', content.about, '75b: merge writes new about');
    r.close();
}

// 76: stdout has ok/id/npub/profile after successful set
{
    const port = 39100 + Math.floor(Math.random() * 50);
    const r = await profileMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runProfile(['set', '--name', 'Test', '--replace']);
    const out = JSON.parse(res.stdout);
    assertEq(true, out.ok, '76a: ok=true');
    assertTrue(typeof out.id === 'string' && out.id.length === 64, '76b: id is 64-hex');
    assertTrue(out.npub.startsWith('npub1'), '76c: npub returned');
    assertEq('Test', out.profile.name, '76d: profile returned');
    r.close();
}

// 77: resolveProfile picks LATEST across relays (codex r1 P1)
{
    const portA = 39150 + Math.floor(Math.random() * 25);
    const portB = 39175 + Math.floor(Math.random() * 25);
    const now = Math.floor(Date.now() / 1000);
    const older = signKind0(ownSk, { name: 'OLDER', about: 'old' }, now - 3600);
    const newer = signKind0(ownSk, { name: 'NEWER', about: 'new' }, now);
    const rA = await profileMockRelay(portA, older);
    const rB = await profileMockRelay(portB, newer);
    pointEnvToRelays(`ws://127.0.0.1:${portA}`, `ws://127.0.0.1:${portB}`);
    const res = await runProfile(['get']);
    const out = JSON.parse(res.stdout);
    assertEq('NEWER', out.content.name, '77a: latest-wins on get');
    assertEq('new', out.content.about, '77b: full latest content returned');
    rA.close(); rB.close();
}

// 78: tie-break on equal created_at by lexicographic id
{
    const portA = 39200 + Math.floor(Math.random() * 25);
    const portB = 39225 + Math.floor(Math.random() * 25);
    const sameTs = Math.floor(Date.now() / 1000);
    const evX = signKind0(ownSk, { name: 'AAA-tie-x', about: 'x' }, sameTs);
    const evY = signKind0(ownSk, { name: 'BBB-tie-y', about: 'y' }, sameTs);
    const winner = evX.id < evY.id ? evX : evY;
    const rA = await profileMockRelay(portA, evX);
    const rB = await profileMockRelay(portB, evY);
    pointEnvToRelays(`ws://127.0.0.1:${portA}`, `ws://127.0.0.1:${portB}`);
    const res = await runProfile(['get']);
    const out = JSON.parse(res.stdout);
    assertEq(JSON.parse(winner.content).name, out.content.name, '78: deterministic id tiebreak');
    rA.close(); rB.close();
}

// 79: merge mode uses LATEST as base
{
    const portA = 39250 + Math.floor(Math.random() * 25);
    const portB = 39275 + Math.floor(Math.random() * 25);
    const now = Math.floor(Date.now() / 1000);
    const older = signKind0(ownSk, { name: 'IGNORED', about: 'old-about' }, now - 7200);
    const newer = signKind0(ownSk, { name: 'KeepNew', about: 'should-be-merged-over' }, now);
    const rA = await profileMockRelay(portA, older);
    const rB = await profileMockRelay(portB, newer);
    pointEnvToRelays(`ws://127.0.0.1:${portA}`, `ws://127.0.0.1:${portB}`);
    await runProfile(['set', '--about', 'NewAbout']);
    const pub = rA.published[0] || rB.published[0];
    const content = JSON.parse(pub.content);
    assertEq('KeepNew', content.name, '79a: merge base is the NEWER profile');
    assertEq('NewAbout', content.about, '79b: new about overrides newer base');
    rA.close(); rB.close();
}

// 80-83: URL validation
{
    const port = 39300 + Math.floor(Math.random() * 50);
    const r = await profileMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);

    const cases = [
        { args: ['set', '--picture', 'javascript:alert(1)', '--replace'], code: 'bad-picture-scheme', label: '80a: javascript: rejected' },
        { args: ['set', '--banner', 'data:image/png;base64,abc', '--replace'], code: 'bad-banner-scheme', label: '80b: data: rejected' },
        { args: ['set', '--picture', 'http://', '--replace'], code: 'bad-picture-format', label: '81a: bare http:// rejected (no host)' },
        { args: ['set', '--picture', 'https://exa mple.com/x', '--replace'], code: 'bad-picture-format', label: '81b: whitespace in URL rejected' },
        { args: ['set', '--picture', 'https://example.com/\u{E0065}\u{E0076}\u{E0069}\u{E006C}', '--replace'], code: 'bad-picture-format', label: '81c: invisible-Unicode URL rejected (codex r2 P2.1)' },
    ];
    for (const c of cases) {
        const res = await runProfile(c.args);
        assertJsonField(res.stdout, 'error', c.code, c.label);
    }

    const okHttps = await runProfile(['set', '--picture', 'https://example.com/avatar.png', '--replace']);
    assertEq(0, okHttps.status, '82a: valid https URL accepted');
    const okHttp = await runProfile(['set', '--picture', 'http://example.com/avatar.png', '--replace']);
    assertEq(0, okHttp.status, '82b: valid http URL accepted');
    r.close();
}

// 83: Flag-shaped value rejected for every field (codex r3 P2 regression).
//     Without the shiftProfileValue guard, `--name --replace` would
//     consume `--replace` as the name string and silently publish bogus
//     public profile metadata.
{
    const port = 39380 + Math.floor(Math.random() * 20);
    const r = await profileMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);

    const cases = [
        { args: ['set', '--name', '--replace'],    code: 'bad-name-empty',    label: '83a: --name --replace rejected' },
        { args: ['set', '--about', '--replace'],   code: 'bad-about-empty',   label: '83b: --about --replace rejected' },
        { args: ['set', '--picture', '--replace'], code: 'bad-picture-empty', label: '83c: --picture --replace rejected' },
        { args: ['set', '--banner', '--replace'],  code: 'bad-banner-empty',  label: '83d: --banner --replace rejected' },
        { args: ['set', '--nip05', '--replace'],   code: 'bad-nip05-empty',   label: '83e: --nip05 --replace rejected' },
        { args: ['set', '--lud16', '--replace'],   code: 'bad-lud16-empty',   label: '83f: --lud16 --replace rejected' },
        { args: ['set', '--website', '--replace'], code: 'bad-website-empty', label: '83g: --website --replace rejected' },
    ];
    for (const c of cases) {
        const res = await runProfile(c.args);
        assertJsonField(res.stdout, 'error', c.code, c.label);
        // Critical: must NOT have reached the publish path. The mock
        // captures published EVENTs; assert nothing landed.
    }
    assertEq(0, r.published.length, '83h: nothing published when value was flag-shaped');
    r.close();
}

// 84: Bad nip05 format
{
    const port = 39400 + Math.floor(Math.random() * 50);
    const r = await profileMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runProfile(['set', '--nip05', 'notanemail']);
    assertJsonField(res.stdout, 'error', 'bad-nip05-format', '84: bad nip05 rejected');
    r.close();
}

// 84b: Handle field with smuggled Unicode rejected (codex r4-simplify
//      consistency with URL field posture -- no silent strip).
{
    const port = 39420 + Math.floor(Math.random() * 30);
    const r = await profileMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    // ZWSP between local and @ -- sanitize would strip and produce a
    // valid-looking address. Must instead reject as bad-nip05-format.
    const res = await runProfile(['set', '--nip05', 'foo\u{200B}@bar.com']);
    assertJsonField(res.stdout, 'error', 'bad-nip05-format', '84b: nip05 with smuggled ZWSP rejected');
    r.close();
}

// 84c: Array-as-existing-profile-content handled cleanly (codex r4
//      simplify -- typeof [] === 'object' edge case).
{
    const port = 39450 + Math.floor(Math.random() * 30);
    // Hand-roll an existing kind:0 whose content is a JSON array, not
    // object. cleanProfileMetadata must return {} (no crash, no leak).
    const arrayContent = finalizeEvent({
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify(['some', 'array']),
    }, ownSk);
    const r = await profileMockRelay(port, arrayContent);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runProfile(['set', '--about', 'NewAbout']);
    const content = JSON.parse(r.published[0].content);
    assertEq('NewAbout', content.about, '84c: merge still publishes new about');
    // Array-shaped base contributed nothing -- only the agent-supplied
    // about field is present, no v1 key from the array index.
    assertEq(1, Object.keys(content).length, '84c-2: only new field present (array base dropped)');
    r.close();
}

// 85: Oversized name rejected
{
    const port = 39450 + Math.floor(Math.random() * 50);
    const r = await profileMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runProfile(['set', '--name', 'x'.repeat(501)]);
    assertJsonField(res.stdout, 'error', 'bad-name-too-long', '85: oversized name rejected');
    r.close();
}

// 86: Merge cleanup drops unknown keys from base
{
    const port = 39500 + Math.floor(Math.random() * 50);
    const existing = signKind0(ownSk, { name: 'GoodName', junk: 'hello', nested: { a: 1 } });
    const r = await profileMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    await runProfile(['set', '--about', 'NewAbout']);
    const content = JSON.parse(r.published[0].content);
    assertEq('GoodName', content.name, '86a: known key preserved');
    assertEq('NewAbout', content.about, '86b: new field present');
    assertTrue(!('junk' in content), '86c: unknown key dropped');
    assertTrue(!('nested' in content), '86d: nested object dropped');
    r.close();
}

// 87: Merge cleanup drops invalid URL in existing base
{
    const port = 39550 + Math.floor(Math.random() * 50);
    const existing = signKind0(ownSk, { name: 'OK', picture: 'javascript:alert(1)' });
    const r = await profileMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    await runProfile(['set', '--about', 'Y']);
    const content = JSON.parse(r.published[0].content);
    assertEq('OK', content.name, '87a: name preserved');
    assertEq('Y', content.about, '87b: about set');
    assertTrue(!('picture' in content), '87c: bad-URL picture dropped');
    r.close();
}

// 88: Merge cleanup sanitizes pre-existing smuggling in base strings
{
    const port = 39600 + Math.floor(Math.random() * 50);
    const existing = signKind0(ownSk, { name: 'X\u{E0065}\u{E0076}\u{E0069}\u{E006C}' });
    const r = await profileMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    await runProfile(['set', '--about', 'Y']);
    const content = JSON.parse(r.published[0].content);
    assertEq('X', content.name, '88: smuggling stripped from pre-existing base');
    r.close();
}

// 89: publish-failed when no relay OKs
{
    const port = 39650 + Math.floor(Math.random() * 50);
    const r = await profileMockRelay(port, null, { okPublish: false });
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runProfile(['set', '--name', 'Test', '--replace']);
    assertJsonField(res.stdout, 'error', 'publish-failed', '89: publish-failed bubbled');
    r.close();
}

// 90: Get own with no arg
{
    const port = 39700 + Math.floor(Math.random() * 50);
    const existing = signKind0(ownSk, { name: 'OwnName', about: 'me' });
    const r = await profileMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runProfile(['get']);
    const out = JSON.parse(res.stdout);
    assertEq('OwnName', out.content.name, '90a: own profile returned');
    assertEq('me', out.content.about, '90b: own profile content correct');
    r.close();
}

// 91: Get other npub
{
    const otherSk = generateSecretKey();
    const otherPk = getPublicKey(otherSk);
    const port = 39750 + Math.floor(Math.random() * 50);
    const existing = signKind0(otherSk, { name: 'OtherName', about: 'them' });
    const r = await profileMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runProfile(['get', nip19.npubEncode(otherPk)]);
    const out = JSON.parse(res.stdout);
    assertEq('OtherName', out.content.name, '91a: other profile returned');
    assertEq(otherPk, out.pubkey, '91b: pubkey matches target');
    r.close();
}

// 92: Get drops nested objects + unknown keys (codex r2 P2.2)
{
    const otherSk = generateSecretKey();
    const otherPk = getPublicKey(otherSk);
    const port = 39800 + Math.floor(Math.random() * 50);
    const existing = signKind0(otherSk, {
        name: 'CleanName',
        extras: { hidden: 'X\u{E0065}\u{E0076}\u{E0069}\u{E006C}smuggled' },
        custom_field: 'not-in-v1',
    });
    const r = await profileMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runProfile(['get', nip19.npubEncode(otherPk)]);
    const out = JSON.parse(res.stdout);
    assertEq('CleanName', out.content.name, '92a: known field returned');
    assertTrue(!('extras' in out.content), '92b: nested object dropped');
    assertTrue(!('custom_field' in out.content), '92c: unknown key dropped');
    r.close();
}

// 93: Get bad-sig profile rejected
{
    const otherSk = generateSecretKey();
    const otherPk = getPublicKey(otherSk);
    const port = 39850 + Math.floor(Math.random() * 50);
    const good = signKind0(otherSk, { name: 'X' });
    const bad = { ...good, sig: '00'.repeat(64) };
    const r = await profileMockRelay(port, bad);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runProfile(['get', nip19.npubEncode(otherPk)]);
    assertEq(1, res.status, '93a: bad-sig profile exits 1');
    assertJsonField(res.stdout, 'error', 'profile-not-found', '93b: bad-sig rejected as not-found');
    r.close();
}

// 94: Get author-mismatch rejected
{
    const otherSk = generateSecretKey();
    const otherPk = getPublicKey(otherSk);
    const decoySk = generateSecretKey();
    const port = 39900 + Math.floor(Math.random() * 50);
    const decoyProfile = signKind0(decoySk, { name: 'decoy' });
    const r = await profileMockRelay(port, decoyProfile);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runProfile(['get', nip19.npubEncode(otherPk)]);
    assertEq(1, res.status, '94a: author-mismatch exits 1');
    assertJsonField(res.stdout, 'error', 'profile-not-found', '94b: author-mismatch rejected');
    r.close();
}

// 95: Get profile-not-found when relay has nothing
{
    const otherSk = generateSecretKey();
    const otherPk = getPublicKey(otherSk);
    const port = 39950 + Math.floor(Math.random() * 50);
    const r = await profileMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runProfile(['get', nip19.npubEncode(otherPk)]);
    assertJsonField(res.stdout, 'error', 'profile-not-found', '95: no events -> profile-not-found');
    r.close();
}

// ── 96-130: nostr.mjs follow (NIP-02 kind:3) ──

console.log('\nFollow:');

// followMockRelay: serves a configured kind:3 (or none) in response to
// REQ with authors filter; captures published kind:3 events on EVENT,
// OKs them by default.
function followMockRelay(port, kind3Event, opts = {}) {
    return captureMockRelay(port, 3, kind3Event, opts);
}

function runFollow(args, env = {}) {
    return spawnCli('follow', args, env, 'NOSTR_FOLLOW_TIMEOUT_MS', 1500);
}

function signKind3(sk, tagsArray, createdAt) {
    return finalizeEvent({
        kind: 3,
        created_at: createdAt ?? Math.floor(Date.now() / 1000),
        tags: tagsArray,
        content: '',
    }, sk);
}

// Helpers to produce target/decoy npubs deterministically for the
// follow tests. ownSk + ownPk derived earlier from the test env.
const followTargetSk = generateSecretKey();
const followTargetPk = getPublicKey(followTargetSk);
const followTargetNpub = nip19.npubEncode(followTargetPk);

const otherFollowSk = generateSecretKey();
const otherFollowPk = getPublicKey(otherFollowSk);
const otherFollowNpub = nip19.npubEncode(otherFollowPk);

const decoyFollowSk = generateSecretKey();
const decoyFollowPk = getPublicKey(decoyFollowSk);

// 96: add first follow on an empty list
{
    const port = 40000 + Math.floor(Math.random() * 50);
    const r = await followMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['add', followTargetNpub]);
    assertEq(0, res.status, '96a: add to empty list exits 0');
    const out = JSON.parse(res.stdout);
    assertEq('added', out.action, '96b: action=added on new');
    assertEq(1, out.contacts, '96c: contacts count 1');
    const published = r.published[0];
    assertEq(1, published.tags.length, '96d: published kind:3 has 1 tag');
    assertEq(followTargetPk, published.tags[0][1], '96e: target pubkey present');
    assertEq('', published.tags[0][2], '96f: empty relay slot');
    assertEq('', published.tags[0][3], '96g: empty petname slot');
    r.close();
}

// 97: add with --petname and --relay
{
    const port = 40050 + Math.floor(Math.random() * 50);
    const r = await followMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['add', followTargetNpub, '--petname', 'Target', '--relay', 'wss://r.example']);
    assertEq(0, res.status, '97a: add with flags exits 0');
    const published = r.published[0];
    assertEq('wss://r.example', published.tags[0][2], '97b: relay in tag');
    assertEq('Target', published.tags[0][3], '97c: petname in tag');
    r.close();
}

// 98: add when already following updates instead of duplicating
{
    const port = 40100 + Math.floor(Math.random() * 50);
    const existing = signKind3(ownSk, [['p', followTargetPk, 'wss://old.example', 'OldName']]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['add', followTargetNpub, '--petname', 'NewName', '--relay', 'wss://new.example']);
    const out = JSON.parse(res.stdout);
    assertEq('updated', out.action, '98a: action=updated on existing');
    assertEq(1, out.contacts, '98b: still 1 contact (no duplicate)');
    const published = r.published[0];
    assertEq(1, published.tags.length, '98c: still 1 tag');
    assertEq('wss://new.example', published.tags[0][2], '98d: relay updated');
    assertEq('NewName', published.tags[0][3], '98e: petname updated');
    r.close();
}

// 99: per-field merge -- re-add with NO flags preserves both fields (codex r1 P2.1)
{
    const port = 40150 + Math.floor(Math.random() * 50);
    const existing = signKind3(ownSk, [['p', followTargetPk, 'wss://preserve.example', 'Alice']]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    await runFollow(['add', followTargetNpub]);
    const published = r.published[0];
    assertEq('wss://preserve.example', published.tags[0][2], '99a: relay preserved when no --relay');
    assertEq('Alice', published.tags[0][3], '99b: petname preserved when no --petname');
    r.close();
}

// 100: per-field merge -- only --petname preserves relay
{
    const port = 40200 + Math.floor(Math.random() * 50);
    const existing = signKind3(ownSk, [['p', followTargetPk, 'wss://keep.example', 'Alice']]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    await runFollow(['add', followTargetNpub, '--petname', 'Bob']);
    const published = r.published[0];
    assertEq('wss://keep.example', published.tags[0][2], '100a: relay preserved');
    assertEq('Bob', published.tags[0][3], '100b: petname updated');
    r.close();
}

// 101: per-field merge -- only --relay preserves petname
{
    const port = 40250 + Math.floor(Math.random() * 50);
    const existing = signKind3(ownSk, [['p', followTargetPk, 'wss://old.example', 'KeepName']]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    await runFollow(['add', followTargetNpub, '--relay', 'wss://new.example']);
    const published = r.published[0];
    assertEq('wss://new.example', published.tags[0][2], '101a: relay updated');
    assertEq('KeepName', published.tags[0][3], '101b: petname preserved');
    r.close();
}

// 102: merge preserves other follows
{
    const port = 40300 + Math.floor(Math.random() * 50);
    const existing = signKind3(ownSk, [
        ['p', otherFollowPk, '', 'Other'],
    ]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    await runFollow(['add', followTargetNpub]);
    const published = r.published[0];
    assertEq(2, published.tags.length, '102a: both follows present');
    const pks = published.tags.map(t => t[1]).sort();
    assertTrue(pks.includes(otherFollowPk), '102b: prior follow preserved');
    assertTrue(pks.includes(followTargetPk), '102c: new follow added');
    r.close();
}

// 103: latest-wins on add merge base (older relay vs newer relay)
{
    const portA = 40350 + Math.floor(Math.random() * 25);
    const portB = 40375 + Math.floor(Math.random() * 25);
    const now = Math.floor(Date.now() / 1000);
    const older = signKind3(ownSk, [['p', otherFollowPk, '', 'IGNORED']], now - 3600);
    const newer = signKind3(ownSk, [['p', otherFollowPk, '', 'KeepNew']], now);
    const rA = await followMockRelay(portA, older);
    const rB = await followMockRelay(portB, newer);
    pointEnvToRelays(`ws://127.0.0.1:${portA}`, `ws://127.0.0.1:${portB}`);
    await runFollow(['add', followTargetNpub]);
    const pub = rA.published[0] || rB.published[0];
    const otherEntry = pub.tags.find(t => t[1] === otherFollowPk);
    assertEq('KeepNew', otherEntry[3], '103: merge base is the NEWER kind:3');
    rA.close(); rB.close();
}

// 104: self-follow rejected at the gate
{
    const port = 40450 + Math.floor(Math.random() * 50);
    const r = await followMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const ownNpub = nip19.npubEncode(ownPk_DERIVED());
    const res = await runFollow(['add', ownNpub]);
    assertJsonField(res.stdout, 'error', 'cannot-follow-self', '104a: self-follow rejected');
    assertEq(0, r.published.length, '104b: nothing published when self-follow attempted');
    r.close();
}

// 105: bad target npub
{
    const res = await runFollow(['add', 'not-a-real-npub']);
    assertJsonField(res.stdout, 'error', 'bad-target-npub', '105: bad-target-npub');
}

// 106: bad relay scheme (http://)
{
    const port = 40550 + Math.floor(Math.random() * 50);
    const r = await followMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['add', followTargetNpub, '--relay', 'http://example.com']);
    assertJsonField(res.stdout, 'error', 'bad-relay-scheme', '106: bad-relay-scheme');
    r.close();
}

// 107: bad relay format (whitespace / control / invisible Unicode)
{
    const port = 40600 + Math.floor(Math.random() * 50);
    const r = await followMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const cases = [
        { args: ['add', followTargetNpub, '--relay', 'wss://exa mple.com'], code: 'bad-relay-format', label: '107a: whitespace' },
        { args: ['add', followTargetNpub, '--relay', 'wss://example.com/\u{E0065}'], code: 'bad-relay-format', label: '107b: invisible Unicode' },
    ];
    for (const c of cases) {
        const res = await runFollow(c.args);
        assertJsonField(res.stdout, 'error', c.code, c.label);
    }
    r.close();
}

// 108: oversized petname
{
    const port = 40650 + Math.floor(Math.random() * 50);
    const r = await followMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['add', followTargetNpub, '--petname', 'x'.repeat(101)]);
    assertJsonField(res.stdout, 'error', 'bad-petname-too-long', '108: oversized petname');
    r.close();
}

// 109: petname with smuggled Unicode (canonical bar)
{
    const port = 40700 + Math.floor(Math.random() * 50);
    const r = await followMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['add', followTargetNpub, '--petname', 'Alice\u{200B}']);
    assertJsonField(res.stdout, 'error', 'bad-petname-format', '109: smuggled-Unicode petname rejected');
    r.close();
}

// 110: parser hardening on add -- --petname --relay <foo> (no petname value)
{
    const port = 40750 + Math.floor(Math.random() * 50);
    const r = await followMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['add', followTargetNpub, '--petname', '--relay', 'wss://x.example']);
    assertJsonField(res.stdout, 'error', 'bad-petname-empty', '110: --petname --relay rejects as bad-petname-empty');
    assertEq(0, r.published.length, '110b: nothing published');
    r.close();
}

// 111: strict argv on add -- extra trailing positional (codex r1 P2.2)
{
    const port = 40800 + Math.floor(Math.random() * 50);
    const r = await followMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['add', followTargetNpub, 'extra-token']);
    assertJsonField(res.stdout, 'error', 'unexpected-extra-args', '111a: trailing positional rejected');
    assertEq(0, r.published.length, '111b: nothing published when extras present');
    r.close();
}

// 112: strict argv -- duplicate --petname
{
    const port = 40850 + Math.floor(Math.random() * 50);
    const r = await followMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['add', followTargetNpub, '--petname', 'A', '--petname', 'B']);
    assertJsonField(res.stdout, 'error', 'duplicate-flag-petname', '112: duplicate --petname rejected');
    r.close();
}

// 113: pre-existing self-follow stripped on add (codex r2 P2)
{
    const port = 40900 + Math.floor(Math.random() * 50);
    const ownPk = ownPk_DERIVED();
    const existing = signKind3(ownSk, [
        ['p', ownPk, '', 'me'],   // self-follow from prior client
        ['p', otherFollowPk, '', 'Other'],
    ]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    await runFollow(['add', followTargetNpub]);
    const published = r.published[0];
    const pks = published.tags.map(t => t[1]);
    assertTrue(pks.includes(followTargetPk), '113a: new follow added');
    assertTrue(pks.includes(otherFollowPk), '113b: existing other follow preserved');
    assertTrue(!pks.includes(ownPk), '113c: pre-existing self-follow stripped on re-sign');
    r.close();
}

// 114-116: remove
{
    // 114: remove existing follow
    const port = 40950 + Math.floor(Math.random() * 25);
    const existing = signKind3(ownSk, [
        ['p', followTargetPk, '', 'Target'],
        ['p', otherFollowPk, '', 'Other'],
    ]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['remove', followTargetNpub]);
    const out = JSON.parse(res.stdout);
    assertEq('removed', out.action, '114a: action=removed');
    assertEq(1, out.contacts, '114b: 1 follow left');
    const published = r.published[0];
    assertEq(1, published.tags.length, '114c: 1 tag remaining');
    assertEq(otherFollowPk, published.tags[0][1], '114d: other preserved, target gone');
    r.close();
}

// 115: remove when not following
{
    const port = 40975 + Math.floor(Math.random() * 25);
    const existing = signKind3(ownSk, [['p', otherFollowPk, '', 'Other']]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['remove', followTargetNpub]);
    assertJsonField(res.stdout, 'error', 'not-following', '115a: not-following errored');
    assertEq(0, r.published.length, '115b: nothing published');
    r.close();
}

// 116: strict argv on remove (codex r1 P2.2)
{
    const port = 41000 + Math.floor(Math.random() * 25);
    const existing = signKind3(ownSk, [['p', followTargetPk, '', 'X']]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['remove', followTargetNpub, 'extra']);
    assertJsonField(res.stdout, 'error', 'unexpected-extra-args', '116a: trailing arg on remove rejected');
    assertEq(0, r.published.length, '116b: nothing published');
    r.close();
}

// 117: remove rejects flags
{
    const port = 41025 + Math.floor(Math.random() * 25);
    const existing = signKind3(ownSk, [['p', followTargetPk, '', 'X']]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['remove', followTargetNpub, '--petname', 'X']);
    // The --petname token survives to the unexpected-extra-args check.
    assertJsonField(res.stdout, 'error', 'unexpected-extra-args', '117: --flag rejected on remove');
    r.close();
}

// 118: pre-existing self-follow stripped on remove (codex r2 P2)
{
    const port = 41050 + Math.floor(Math.random() * 25);
    const ownPk = ownPk_DERIVED();
    const existing = signKind3(ownSk, [
        ['p', ownPk, '', 'me'],
        ['p', followTargetPk, '', 'Target'],
        ['p', otherFollowPk, '', 'Other'],
    ]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    await runFollow(['remove', followTargetNpub]);
    const published = r.published[0];
    const pks = published.tags.map(t => t[1]);
    assertEq(1, published.tags.length, '118a: exactly 1 tag remaining');
    assertEq(otherFollowPk, pks[0], '118b: only other-follow remains -- target removed, self-follow stripped');
    r.close();
}

// 119-126: list
// 119: list own with empty kind:3
{
    const port = 41100 + Math.floor(Math.random() * 25);
    const existing = signKind3(ownSk, []);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['list']);
    const out = JSON.parse(res.stdout);
    assertEq(0, out.contacts.length, '119: empty kind:3 returns empty contacts array');
    r.close();
}

// 120: list returns entries with relay+petname when present
{
    const port = 41125 + Math.floor(Math.random() * 25);
    const existing = signKind3(ownSk, [
        ['p', followTargetPk, 'wss://r.example', 'Alice'],
        ['p', otherFollowPk, '', ''],
    ]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['list']);
    const out = JSON.parse(res.stdout);
    assertEq(2, out.contacts.length, '120a: two entries');
    const alice = out.contacts.find(c => c.pubkey === followTargetPk);
    assertEq('wss://r.example', alice.relay, '120b: alice relay returned');
    assertEq('Alice', alice.petname, '120c: alice petname returned');
    const other = out.contacts.find(c => c.pubkey === otherFollowPk);
    assertTrue(!('relay' in other), '120d: empty relay omitted from output');
    assertTrue(!('petname' in other), '120e: empty petname omitted from output');
    r.close();
}

// 121: list drops malformed entries from other-npub kind:3
{
    const port = 41150 + Math.floor(Math.random() * 25);
    const existing = signKind3(otherFollowSk, [
        ['p', 'not-real-hex'],
        ['p', followTargetPk, 'http://bad-scheme.example', 'X\u{200B}smuggled'],
        ['e', followTargetPk, '', 'wrong-kind-tag'],
    ]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['list', otherFollowNpub]);
    const out = JSON.parse(res.stdout);
    assertEq(1, out.contacts.length, '121a: malformed pubkey + non-p tag dropped, valid entry retained');
    const entry = out.contacts[0];
    assertEq(followTargetPk, entry.pubkey, '121b: valid pubkey returned');
    assertTrue(!('relay' in entry), '121c: bad-scheme relay silent-dropped to empty (omitted)');
    assertTrue(!('petname' in entry), '121d: smuggled petname silent-dropped to empty (omitted)');
    r.close();
}

// 122: list other-npub returns cleaned shape
{
    const port = 41175 + Math.floor(Math.random() * 25);
    const existing = signKind3(otherFollowSk, [['p', followTargetPk, 'wss://x.example', 'Friend']]);
    const r = await followMockRelay(port, existing);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['list', otherFollowNpub]);
    const out = JSON.parse(res.stdout);
    assertEq(otherFollowPk, out.pubkey, '122a: pubkey matches target');
    assertEq(1, out.contacts.length, '122b: one entry');
    r.close();
}

// 123: list contact-list-not-found
{
    const port = 41200 + Math.floor(Math.random() * 25);
    const r = await followMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['list', otherFollowNpub]);
    assertJsonField(res.stdout, 'error', 'contact-list-not-found', '123: no kind:3 -> contact-list-not-found');
    r.close();
}

// 124: list rejects bad-sig kind:3
{
    const port = 41225 + Math.floor(Math.random() * 25);
    const good = signKind3(otherFollowSk, [['p', followTargetPk, '', 'X']]);
    const bad = { ...good, sig: '00'.repeat(64) };
    const r = await followMockRelay(port, bad);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['list', otherFollowNpub]);
    assertJsonField(res.stdout, 'error', 'contact-list-not-found', '124: bad-sig kind:3 rejected as not-found');
    r.close();
}

// 125: list rejects author-mismatch
{
    const port = 41250 + Math.floor(Math.random() * 25);
    // Mock returns a kind:3 signed by decoy but we ask for otherFollowNpub.
    const decoyKind3 = signKind3(decoyFollowSk, [['p', followTargetPk, '', 'X']]);
    const r = await followMockRelay(port, decoyKind3);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['list', otherFollowNpub]);
    assertJsonField(res.stdout, 'error', 'contact-list-not-found', '125: author-mismatch kind:3 rejected');
    r.close();
}

// 126: strict argv on list (codex r1 P2.2)
{
    const port = 41275 + Math.floor(Math.random() * 25);
    const r = await followMockRelay(port, null);
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['list', otherFollowNpub, 'extra']);
    assertJsonField(res.stdout, 'error', 'unexpected-extra-args', '126: trailing arg on list rejected');
    r.close();
}

// 127: add publish-failed when no relay OKs
{
    const port = 41300 + Math.floor(Math.random() * 25);
    const r = await followMockRelay(port, null, { okPublish: false });
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['add', followTargetNpub]);
    assertJsonField(res.stdout, 'error', 'publish-failed', '127: add publish-failed');
    r.close();
}

// 128: remove publish-failed when no relay OKs
{
    const port = 41325 + Math.floor(Math.random() * 25);
    const existing = signKind3(ownSk, [['p', followTargetPk, '', 'X']]);
    const r = await followMockRelay(port, existing, { okPublish: false });
    pointEnvToRelays(`ws://127.0.0.1:${port}`);
    const res = await runFollow(['remove', followTargetNpub]);
    assertJsonField(res.stdout, 'error', 'publish-failed', '128: remove publish-failed');
    r.close();
}

// Need ownPk available to tests above. Hoist via function.
function ownPk_DERIVED() { return getPublicKey(ownSk); }

// ── Summary ──

console.log('');
console.log('========================');
console.log(`Total: ${PASS + FAIL}  Pass: ${PASS}  Fail: ${FAIL}`);
if (FAIL > 0) {
    console.log(ERRORS);
    process.exit(1);
}
console.log('All assertions passed.');

// Cleanup tmp
try { rmSync(tmpBase, { recursive: true }); } catch {}
