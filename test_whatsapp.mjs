#!/usr/bin/env node
// Tests for whatsapp.mjs — poll, send, whoami, help, errors
//
// Tests the file-based IPC layer (spool + outbox) and argument parsing.
// Baileys connection (login, serve) is not tested — requires real WhatsApp account.

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'whatsapp.mjs');

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

// ── Setup ──

const tmpBase = mkdtempSync(join(tmpdir(), 'whatsapp-test-'));
const sessionDir = join(tmpBase, 'whatsapp-session');
const spoolDir = join(tmpBase, 'whatsapp-spool');
const outboxDir = join(tmpBase, 'whatsapp-outbox');
mkdirSync(sessionDir);
mkdirSync(spoolDir);
mkdirSync(outboxDir);

// Env file for JID filtering tests
const envFile = join(tmpBase, 'whatsapp.env');
writeFileSync(envFile, 'WHATSAPP_ALLOWED_JIDS=123@s.whatsapp.net,456@s.whatsapp.net\nWHATSAPP_SELF_JID=123@s.whatsapp.net\n');

const baseFlags = ['--session-dir', sessionDir, '--spool-dir', spoolDir, '--outbox-dir', outboxDir, '--env-file', envFile];

function run(...cmdArgs) {
    try {
        const stdout = execFileSync('node', [CLI, ...baseFlags, ...cmdArgs], {
            encoding: 'utf8',
            timeout: 10000,
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

// Helper: clear spool dir between tests
function clearSpool() {
    for (const f of readdirSync(spoolDir)) {
        try { rmSync(join(spoolDir, f)); } catch {}
    }
}

// Helper: clear outbox dir between tests
function clearOutbox() {
    for (const f of readdirSync(outboxDir)) {
        try { rmSync(join(outboxDir, f)); } catch {}
    }
}

// ── Tests ──

console.log('=== whatsapp.mjs tests ===');
console.log('');

// ── Baileys socket config (source checks) ──
// These prevent regression of the noise-handler bug: makeWASocket MUST be
// called with fetchLatestBaileysVersion() and makeCacheableSignalKeyStore().

console.log('baileys config:');

const src = readFileSync(CLI, 'utf8');
assertContains(src, 'fetchLatestBaileysVersion', 'source uses fetchLatestBaileysVersion');
assertContains(src, 'makeCacheableSignalKeyStore', 'source uses makeCacheableSignalKeyStore');
// Verify both doLogin and doServe use version param
const loginBlock = src.slice(src.indexOf('async function doLogin'), src.indexOf('async function doServe'));
const serveBlock = src.slice(src.indexOf('async function doServe'), src.indexOf('function doWhoami'));
assertContains(loginBlock, 'version', 'doLogin passes version to makeWASocket');
assertContains(loginBlock, 'makeCacheableSignalKeyStore', 'doLogin uses signal key cache');
assertContains(serveBlock, 'version', 'doServe passes version to makeWASocket');
assertContains(serveBlock, 'makeCacheableSignalKeyStore', 'doServe uses signal key cache');

console.log('');

// ── help ──

console.log('help:');

let r = run('help');
assertJsonField(r.stdout, 'commands.poll', undefined, 'help lists poll command');
assertJsonField(r.stdout, 'commands.send', undefined, 'help lists send command');
assertJsonField(r.stdout, 'commands.serve', undefined, 'help lists serve command');
assertJsonField(r.stdout, 'commands.login', undefined, 'help lists login command');
assertJsonField(r.stdout, 'commands.whoami', undefined, 'help lists whoami command');
try {
    const flags = JSON.parse(r.stdout).flags;
    assertEq(true, flags.length >= 3, 'help lists flags');
} catch { fail('help lists flags'); }

console.log('');

// ── poll (empty) ──

console.log('poll (empty):');

clearSpool();
r = run('poll');
assertEq(1, r.status, 'poll with empty spool exits 1');

console.log('');

// ── poll (single text message) ──

console.log('poll (text):');

clearSpool();
writeFileSync(join(spoolDir, '1000-msg001.jsonl'), JSON.stringify({
    id: 'msg001', jid: '123@s.whatsapp.net', from: 'Juho',
    text: 'hello agent', ts: '2026-04-03T10:00:00.000Z', type: 'text',
}));

r = run('poll');
assertEq(0, r.status, 'poll with message exits 0');
const lines = r.stdout.split('\n').filter(Boolean);
assertEq(1, lines.length, 'poll outputs 1 line');
assertJsonField(lines[0], 'id', 'msg001', 'poll returns message id');
assertJsonField(lines[0], 'jid', '123@s.whatsapp.net', 'poll returns jid');
assertJsonField(lines[0], 'from', 'Juho', 'poll returns from');
assertJsonField(lines[0], 'text', 'hello agent', 'poll returns text');
assertJsonField(lines[0], 'type', 'text', 'poll returns type text');

// Files should be deleted after poll
assertEq(0, readdirSync(spoolDir).filter(f => f.endsWith('.jsonl')).length, 'poll deletes spool files');

console.log('');

// ── poll (multiple messages, sorted) ──

console.log('poll (multiple):');

clearSpool();
writeFileSync(join(spoolDir, '2000-msg002.jsonl'), JSON.stringify({
    id: 'msg002', jid: '123@s.whatsapp.net', from: 'Juho',
    text: 'second', ts: '2026-04-03T10:00:02.000Z', type: 'text',
}));
writeFileSync(join(spoolDir, '1000-msg001.jsonl'), JSON.stringify({
    id: 'msg001', jid: '123@s.whatsapp.net', from: 'Juho',
    text: 'first', ts: '2026-04-03T10:00:01.000Z', type: 'text',
}));

r = run('poll');
const multiLines = r.stdout.split('\n').filter(Boolean);
assertEq(2, multiLines.length, 'poll outputs 2 lines');
assertJsonField(multiLines[0], 'text', 'first', 'poll outputs older message first');
assertJsonField(multiLines[1], 'text', 'second', 'poll outputs newer message second');

console.log('');

// ── poll (voice message) ──

console.log('poll (voice):');

clearSpool();
writeFileSync(join(spoolDir, '3000-msg003.jsonl'), JSON.stringify({
    id: 'msg003', jid: '123@s.whatsapp.net', from: 'Juho',
    text: null, ts: '2026-04-03T10:00:03.000Z', type: 'voice', duration: 5,
}));

r = run('poll');
assertEq(0, r.status, 'poll voice exits 0');
assertJsonField(r.stdout.trim(), 'type', 'voice', 'poll voice has type voice');
assertJsonField(r.stdout.trim(), 'duration', '5', 'poll voice has duration');

console.log('');

// ── poll (image with caption) ──

console.log('poll (image):');

clearSpool();
writeFileSync(join(spoolDir, '4000-msg004.jsonl'), JSON.stringify({
    id: 'msg004', jid: '123@s.whatsapp.net', from: 'Juho',
    text: 'look at this', ts: '2026-04-03T10:00:04.000Z', type: 'image',
    mimetype: 'image/jpeg',
}));

r = run('poll');
assertJsonField(r.stdout.trim(), 'type', 'image', 'poll image has type image');
assertJsonField(r.stdout.trim(), 'text', 'look at this', 'poll image has caption');
assertJsonField(r.stdout.trim(), 'mimetype', 'image/jpeg', 'poll image has mimetype');

console.log('');

// ── poll (document) ──

console.log('poll (document):');

clearSpool();
writeFileSync(join(spoolDir, '5000-msg005.jsonl'), JSON.stringify({
    id: 'msg005', jid: '123@s.whatsapp.net', from: 'Juho',
    text: null, ts: '2026-04-03T10:00:05.000Z', type: 'document',
    filename: 'report.pdf', mimetype: 'application/pdf',
}));

r = run('poll');
assertJsonField(r.stdout.trim(), 'type', 'document', 'poll document has type document');
assertJsonField(r.stdout.trim(), 'filename', 'report.pdf', 'poll document has filename');

console.log('');

// ── send ──

console.log('send:');

clearOutbox();
r = run('send', '123@s.whatsapp.net', 'hello', 'human');
assertEq(0, r.status, 'send exits 0');
assertJsonField(r.stdout, 'ok', 'true', 'send returns ok');
assertJsonField(r.stdout, 'to', '123@s.whatsapp.net', 'send returns to jid');
// Since serve isn't running, should have queued flag
assertJsonField(r.stdout, 'queued', 'true', 'send reports queued when serve not running');

// Verify outbox file was created
const outboxFiles = readdirSync(outboxDir).filter(f => f.endsWith('.jsonl'));
assertEq(1, outboxFiles.length, 'send creates outbox file');

const outboxContent = JSON.parse(readFileSync(join(outboxDir, outboxFiles[0]), 'utf8'));
assertEq('123@s.whatsapp.net', outboxContent.jid, 'outbox file has correct jid');
assertEq('hello human', outboxContent.text, 'outbox file has correct text');
assertEq(true, !!outboxContent.ts, 'outbox file has timestamp');

console.log('');

// ── send missing args ──

console.log('send (errors):');

r = run('send');
assertJsonField(r.stdout, 'error', undefined, 'send no args gives error');
assertContains(r.stdout, 'usage', 'send error mentions usage');

r = run('send', '123@s.whatsapp.net');
assertJsonField(r.stdout, 'error', undefined, 'send no message gives error');

console.log('');

// ── whoami (no session) ──

console.log('whoami:');

r = run('whoami');
assertJsonField(r.stdout, 'error', undefined, 'whoami no session gives error');
assertContains(r.stdout, 'No session', 'whoami error mentions missing session');

// With mock creds.json
writeFileSync(join(sessionDir, 'creds.json'), JSON.stringify({
    me: { id: '123456789@s.whatsapp.net', name: 'Test User' },
}));

r = run('whoami');
assertEq(0, r.status, 'whoami with session exits 0');
assertJsonField(r.stdout, 'jid', '123456789@s.whatsapp.net', 'whoami returns jid');
assertJsonField(r.stdout, 'name', 'Test User', 'whoami returns name');

console.log('');

// ── unknown flags ──

console.log('flags:');

// Unknown --flag should not hang (passes through to command)
r = run('--bogus', 'help');
assertJsonField(r.stdout, 'commands.poll', undefined, 'unknown flag falls through to command');

console.log('');

// ── credential errors ──

console.log('errors:');

// No SUDO_USER and no flags
try {
    const out = execFileSync('node', [CLI, 'poll'], {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, SUDO_USER: '' },
    });
    assertContains(out, 'error', 'no sudo/flags gives error');
} catch (e) {
    const out = (e.stdout || '').trim();
    assertContains(out, 'error', 'no sudo/flags gives error');
    assertContains(out, 'sudo', 'error mentions sudo');
}

console.log('');

// ── poll after drain (idempotent) ──

console.log('poll (idempotent):');

clearSpool();
writeFileSync(join(spoolDir, '9000-msg009.jsonl'), JSON.stringify({
    id: 'msg009', jid: '123@s.whatsapp.net', from: 'Juho',
    text: 'once', ts: '2026-04-03T10:00:09.000Z', type: 'text',
}));

r = run('poll');
assertEq(0, r.status, 'first poll exits 0');
r = run('poll');
assertEq(1, r.status, 'second poll exits 1 (already drained)');

console.log('');

// ── Cleanup ──

rmSync(tmpBase, { recursive: true, force: true });

// ── Results ──

console.log(`=== Results: ${PASS} passed, ${FAIL} failed ===`);
if (FAIL > 0) {
    console.log('\nFailures:' + ERRORS);
    process.exit(1);
}
