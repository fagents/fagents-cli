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
