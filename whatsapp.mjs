#!/usr/bin/env node
// whatsapp.mjs — agent-first WhatsApp client via Baileys
// All output is JSON. Agents are the users.
//
// Architecture: serve (long-running) <-> flat files <-> poll/send (instant)
//   serve: Baileys WebSocket -> writes incoming to whatsapp-spool/
//          watches whatsapp-outbox/ -> sends via Baileys
//   poll:  reads + deletes whatsapp-spool/ files -> JSON lines to stdout
//   send:  writes to whatsapp-outbox/ -> serve picks up and sends
//
// Credential loading:
//   --session-dir, --spool-dir, --outbox-dir flags for testing
//   Otherwise, must be called via: sudo -u fagents node whatsapp.mjs <command>
//   Resolves caller from $SUDO_USER, loads dirs from /home/fagents/.agents/<caller>/
//
// Commands:
//   whatsapp.mjs login                     — QR code scan, save session
//   whatsapp.mjs serve                     — long-running: relay messages via spool files
//   whatsapp.mjs poll                      — read + drain incoming spool
//   whatsapp.mjs send <jid> <message>      — queue outgoing message
//   whatsapp.mjs whoami                    — show linked number/session info
//   whatsapp.mjs help                      — command list

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const CREDS_DIR = '/home/fagents/.agents';

// Suppress Baileys internal logging noise
const silentLogger = {
    level: 'silent', info: () => {}, warn: () => {}, debug: () => {}, trace: () => {},
    error: (...a) => console.error('[baileys]', ...a),
    fatal: (...a) => console.error('[baileys:fatal]', ...a),
    child: () => silentLogger,
};

function err(msg) {
    process.stdout.write(JSON.stringify({ error: msg }) + '\n');
    process.exit(1);
}

// Parse global flags before command
const args = process.argv.slice(2);
let sessionDir = '';
let spoolDir = '';
let outboxDir = '';
let envFile = '';

flagLoop: while (args.length && args[0].startsWith('--')) {
    const flag = args.shift();
    switch (flag) {
        case '--session-dir': sessionDir = args.shift() || ''; break;
        case '--spool-dir':   spoolDir = args.shift() || ''; break;
        case '--outbox-dir':  outboxDir = args.shift() || ''; break;
        case '--env-file':    envFile = args.shift() || ''; break;
        default: args.unshift(flag); break flagLoop;
    }
}

// Resolve credentials — flags mode or sudo mode
const caller = process.env.SUDO_USER || '';
if (sessionDir) {
    // Flags mode — derive missing dirs from session-dir's parent
    const agentDir = dirname(sessionDir);
    spoolDir = spoolDir || join(agentDir, 'whatsapp-spool');
    outboxDir = outboxDir || join(agentDir, 'whatsapp-outbox');
    envFile = envFile || join(agentDir, 'whatsapp.env');
} else {
    // Sudo mode — resolve from $SUDO_USER
    if (!caller) err('Must be called via sudo -u fagents (or use --session-dir)');
    const agentDir = join(CREDS_DIR, caller);
    sessionDir = join(agentDir, 'whatsapp-session');
    spoolDir = join(agentDir, 'whatsapp-spool');
    outboxDir = join(agentDir, 'whatsapp-outbox');
    envFile = join(agentDir, 'whatsapp.env');
}

// Ensure spool + outbox dirs exist
for (const d of [spoolDir, outboxDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// Load env file (allowed JIDs, self JID)
let allowedJids = process.env.WHATSAPP_ALLOWED_JIDS || '';
let selfJid = process.env.WHATSAPP_SELF_JID || '';
if (envFile && existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if (key === 'WHATSAPP_ALLOWED_JIDS' && !allowedJids) allowedJids = val;
        if (key === 'WHATSAPP_SELF_JID' && !selfJid) selfJid = val;
    }
}

const cmd = args.shift() || 'help';

// ── Commands ──

switch (cmd) {
    case 'login':  await doLogin(); break;
    case 'serve':  await doServe(); break;
    case 'poll':   doPoll(); break;
    case 'send':   await doSend(); break;
    case 'whoami': doWhoami(); break;
    case 'help': case '--help': case '-h': default: doHelp(); break;
}

// ── poll: read + drain spool -> JSON lines to stdout ──

function doPoll() {
    if (!existsSync(spoolDir)) process.exit(1);

    const files = readdirSync(spoolDir)
        .filter(f => f.endsWith('.jsonl'))
        .sort();

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
        } catch {
            // File consumed by concurrent poll — skip
        }
    }

    process.exit(wrote ? 0 : 1);
}

// ── send: queue outgoing message via outbox file ──

async function doSend() {
    const jid = args.shift();
    const text = args.join(' ');
    if (!jid || !text) err('usage: send <jid> <message>');

    const msg = { jid, text, ts: new Date().toISOString() };
    const fname = `${randomUUID()}.jsonl`;
    const fpath = join(outboxDir, fname);
    writeFileSync(fpath, JSON.stringify(msg));

    // Wait up to 5s for serve to pick it up (file disappears)
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (!existsSync(fpath)) {
            process.stdout.write(JSON.stringify({ ok: true, to: jid }) + '\n');
            return;
        }
        await new Promise(r => setTimeout(r, 200));
    }

    // Serve didn't pick it up — still queued
    process.stdout.write(JSON.stringify({ ok: true, to: jid, queued: true, note: 'serve may not be running' }) + '\n');
}

// ── login: QR code scan, save session ──

async function doLogin() {
    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason } = baileys;
    const qrcode = (await import('qrcode-terminal')).default;

    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

    const MAX_RETRIES = 5;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
            version,
            logger: silentLogger,
            printQRInTerminal: false,
            browser: ['fagents', 'cli', '1.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
        });

        sock.ev.on('creds.update', saveCreds);

        try {
            await new Promise((resolve, reject) => {
                sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
                    if (qr) {
                        console.error('Scan this QR in WhatsApp > Linked Devices:');
                        qrcode.generate(qr, { small: true });
                    }
                    if (connection === 'open') resolve(sock);
                    if (connection === 'close') {
                        const code = lastDisconnect?.error?.output?.statusCode;
                        if (code === DisconnectReason?.loggedOut) {
                            reject(new Error('Logged out — delete session and re-login'));
                        } else {
                            reject({ retryable: true, code });
                        }
                    }
                });
            });

            // Connected — output result and exit
            const me = sock.user;
            process.stdout.write(JSON.stringify({
                ok: true,
                jid: me?.id || null,
                name: me?.name || me?.verifiedName || null,
            }) + '\n');
            // Wait for creds to flush before exiting
            await new Promise(r => setTimeout(r, 2000));
            sock.end(undefined);
            return;
        } catch (e) {
            if (e instanceof Error) err(e.message); // non-retryable (logged out)
            if (e.retryable && attempt < MAX_RETRIES) {
                const delay = attempt * 2;
                console.error(`Connection failed (code ${e.code}), retrying in ${delay}s... (${attempt}/${MAX_RETRIES})`);
                await new Promise(r => setTimeout(r, delay * 1000));
                continue;
            }
            err(`Login failed after ${attempt} attempts (code ${e.code})`);
        }
    }
}

// ── serve: long-running Baileys relay ──

async function doServe() {
    const credsFile = join(sessionDir, 'creds.json');
    if (!existsSync(credsFile)) err('No session found — run login first');

    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason, downloadMediaMessage } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    // Write PID file
    const pidFile = join(dirname(sessionDir), 'whatsapp-serve.pid');
    writeFileSync(pidFile, String(process.pid));

    // Track sent message IDs to skip echo-back in self-chat
    const sentIds = new Set();

    let sock;
    let reconnectDelay = 1000;
    const MAX_DELAY = 60000;

    async function connect() {
        sock = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
            version,
            logger: silentLogger,
            printQRInTerminal: false,
            browser: ['fagents', 'cli', '1.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
            if (connection === 'open') {
                reconnectDelay = 1000;
                try { await sock.sendPresenceUpdate('unavailable'); } catch {}
                console.error(`[whatsapp-serve] Connected as ${sock.user?.id}`);
            }
            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code === DisconnectReason?.loggedOut) {
                    console.error('[whatsapp-serve] Logged out — exiting');
                    cleanup();
                    process.exit(1);
                }
                console.error(`[whatsapp-serve] Disconnected (code: ${code}), reconnecting in ${reconnectDelay}ms...`);
                setTimeout(connect, reconnectDelay);
                reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
            }
        });

        // Incoming messages -> spool files
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                const remoteJid = msg.key.remoteJid;
                const remoteJidAlt = msg.key.remoteJidAlt || '';

                // Skip echo of our own sent messages
                if (msg.key.fromMe && sentIds.has(msg.key.id)) continue;

                // Filter by allowed JIDs (check both lid and s.whatsapp.net formats)
                if (allowedJids && !isAllowed(remoteJid) && !isAllowed(remoteJidAlt)) continue;

                // Skip reactions (emoji reactions on messages — not useful as inbox entries)
                if (msg.message?.reactionMessage) continue;

                // Extract text content
                const text = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || msg.message?.imageMessage?.caption
                    || msg.message?.videoMessage?.caption
                    || null;

                // Extract reply context if present
                const ctx = msg.message?.extendedTextMessage?.contextInfo;
                let replyTo = null;
                if (ctx?.quotedMessage) {
                    replyTo = {
                        id: ctx.stanzaId || null,
                        from: ctx.participant?.split('@')[0] || null,
                        text: ctx.quotedMessage.conversation
                            || ctx.quotedMessage.extendedTextMessage?.text
                            || null,
                    };
                }

                // Detect message type
                let type = 'text';
                const extra = {};
                if (msg.message?.audioMessage) {
                    type = 'voice';
                    extra.duration = msg.message.audioMessage.seconds;
                    // Download + decrypt voice for transcription
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const audioPath = join(spoolDir, `${Date.now()}-${msg.key.id}.oga`);
                        writeFileSync(audioPath, buffer);
                        extra.audio_path = audioPath;
                    } catch (e) {
                        console.error(`[whatsapp-serve] Voice download failed: ${e.message}`);
                    }
                } else if (msg.message?.imageMessage) {
                    type = 'image';
                    extra.mimetype = msg.message.imageMessage.mimetype;
                } else if (msg.message?.documentMessage) {
                    type = 'document';
                    extra.filename = msg.message.documentMessage.fileName;
                    extra.mimetype = msg.message.documentMessage.mimetype;
                } else if (msg.message?.videoMessage) {
                    type = 'video';
                    extra.duration = msg.message.videoMessage.seconds;
                }

                // Use alt JID (phone@s.whatsapp.net) for spool entry if available
                const jidForEntry = remoteJidAlt || remoteJid;

                const ts = new Date((msg.messageTimestamp || Date.now() / 1000) * 1000).toISOString();
                const entry = {
                    id: msg.key.id,
                    jid: jidForEntry,
                    from: msg.pushName || remoteJid?.split('@')[0] || 'unknown',
                    text,
                    ts,
                    type,
                    ...extra,
                };
                if (replyTo) entry.reply_to = replyTo;

                const sanitizedId = (msg.key.id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
                const fname = `${Date.now()}-${sanitizedId}.jsonl`;
                try {
                    writeFileSync(join(spoolDir, fname), JSON.stringify(entry));
                } catch (e) {
                    console.error(`[whatsapp-serve] Spool write failed: ${e.message}`);
                }
            }
        });
    }

    // Outbox drain loop (1s interval)
    const outboxInterval = setInterval(() => {
        if (!sock) return;
        let files;
        try { files = readdirSync(outboxDir).filter(f => f.endsWith('.jsonl')); }
        catch { return; }

        for (const f of files) {
            const fpath = join(outboxDir, f);
            try {
                const data = JSON.parse(readFileSync(fpath, 'utf8'));
                sock.sendMessage(data.jid, { text: data.text })
                    .then((result) => {
                        // Track sent ID to skip echo-back
                        if (result?.key?.id) {
                            sentIds.add(result.key.id);
                            setTimeout(() => sentIds.delete(result.key.id), 60000);
                        }
                        try { unlinkSync(fpath); } catch {}
                    })
                    .catch(e => console.error(`[whatsapp-serve] Send failed: ${e.message}`));
            } catch (e) {
                console.error(`[whatsapp-serve] Bad outbox file ${f}: ${e.message}`);
                try { unlinkSync(fpath); } catch {}
            }
        }
    }, 1000);

    function cleanup() {
        clearInterval(outboxInterval);
        try { unlinkSync(pidFile); } catch {}
        if (sock) try { sock.end(undefined); } catch {}
    }

    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('SIGINT', () => { cleanup(); process.exit(0); });

    await connect();

    // Keep alive — serve runs until killed
    await new Promise(() => {});
}

// ── whoami: show linked session info ──

function doWhoami() {
    const credsFile = join(sessionDir, 'creds.json');
    if (!existsSync(credsFile)) err('No session found — run login first');

    try {
        const creds = JSON.parse(readFileSync(credsFile, 'utf8'));
        process.stdout.write(JSON.stringify({
            jid: creds.me?.id || null,
            name: creds.me?.name || creds.me?.verifiedName || null,
        }) + '\n');
    } catch (e) {
        err(`Failed to read session: ${e.message}`);
    }
}

// ── help: command list ──

function doHelp() {
    process.stdout.write(JSON.stringify({
        commands: {
            login: 'login — scan QR code to link WhatsApp',
            serve: 'serve — long-running: relay messages via spool files',
            poll: 'poll — read + drain incoming spool (JSON lines)',
            send: 'send <jid> <message> — queue outgoing message',
            whoami: 'whoami — show linked number/session info',
        },
        flags: ['--session-dir <dir>', '--spool-dir <dir>', '--outbox-dir <dir>', '--env-file <file>'],
        notes: 'Without --session-dir, must be called via: sudo -u fagents node whatsapp.mjs',
    }) + '\n');
}

// ── JID allowlist check ──

function isAllowed(jid) {
    if (!allowedJids) return true;
    return allowedJids.split(',').some(a => {
        a = a.trim();
        return jid === a || jid?.startsWith(a.split('@')[0] + '@');
    });
}
