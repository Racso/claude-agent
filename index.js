#!/usr/bin/env node
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, mkdirSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { parse as parseToml } from "smol-toml";

const __dirname          = dirname(fileURLToPath(import.meta.url));
const SESS_FILE          = join(__dirname, "sessions.json");
const CONTACTS_FILE      = join(__dirname, "contacts.json");
const SANDBOX_LAUNCH     = join(__dirname, "sandbox", "launch");
const ERROR_LOG          = join(__dirname, "errors.log");

// ── Config ────────────────────────────────────────────────────────────────────
const config             = parseToml(readFileSync(join(__dirname, "config.toml"), "utf8"));
const ADMIN_NUMBERS      = new Set(config.admins?.numbers ?? []);
const GROUP_MENTION_ONLY = config.settings?.group_mention_only ?? true;

// ── Error logging ─────────────────────────────────────────────────────────────
function logError(error, context = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        ...context,
        message: error.message,
        stack: error.stack,
    };
    try { appendFileSync(ERROR_LOG, JSON.stringify(entry) + "\n"); } catch {}
}

process.on("uncaughtException", (e) => {
    if (e.code === "EPIPE") return; // harmless broken-pipe noise, ignore
    console.error("[uncaughtException]", e.message);
    logError(e, { source: "uncaughtException" });
});

// ── Session persistence ───────────────────────────────────────────────────────
const sessions = (() => {
    try { return JSON.parse(readFileSync(SESS_FILE, "utf8")); } catch { return {}; }
})();

function saveSessions() {
    writeFileSync(SESS_FILE, JSON.stringify(sessions, null, 2));
}

// ── Contacts ──────────────────────────────────────────────────────────────────
function loadContacts() {
    try { return JSON.parse(readFileSync(CONTACTS_FILE, "utf8")); } catch { return {}; }
}

// ── Voice note transcription ──────────────────────────────────────────────────
const TRANSCRIBE  = join(__dirname, "transcribe.sh");
const SPEAK       = join(__dirname, "speak.sh");

const VOICE_DEBUG_DIR = join(__dirname, "voice_debug");

async function transcribeVoiceNote(msg) {
    const freshMsg = await sock.updateMediaMessage(msg).catch(() => msg);
    const buffer   = await downloadMediaMessage(freshMsg, "buffer", {},
        { logger: pino({ level: "silent" }), reuploadRequest: m => sock.updateMediaMessage(m) });
    const filename  = `wa_voice_${Date.now()}_${Math.random().toString(36).slice(2)}.ogg`;
    const debugFile = join(VOICE_DEBUG_DIR, filename);
    const tmpFile   = join(tmpdir(), filename);
    try { mkdirSync(VOICE_DEBUG_DIR, { recursive: true }); } catch {}
    writeFileSync(tmpFile, buffer);
    writeFileSync(debugFile, buffer);
    console.log(`[voice] saved ${filename} (${buffer.length} bytes)`);
    try {
        return await new Promise((resolve, reject) => {
            const proc = spawn(TRANSCRIBE, [tmpFile]);
            let out = "", err = "";
            proc.stdout.on("data", d => out += d);
            proc.stderr.on("data", d => err += d);
            proc.on("close", code => {
                if (code !== 0) reject(new Error(`transcribe exit ${code}: ${err.trim()}`));
                else resolve(out.trim());
            });
            proc.on("error", reject);
        });
    } finally {
        try { unlinkSync(tmpFile); } catch {}
    }
}

// ── Text-to-speech ────────────────────────────────────────────────────────────
async function textToSpeech(text) {
    const tmpFile = join(tmpdir(), `wa_tts_${Date.now()}_${Math.random().toString(36).slice(2)}.opus`);
    await new Promise((resolve, reject) => {
        const proc = spawn(SPEAK, [text, tmpFile]);
        let err = "";
        proc.stderr.on("data", d => err += d);
        proc.on("close", code => {
            if (code !== 0) reject(new Error(`speak exit ${code}: ${err.trim()}`));
            else resolve();
        });
        proc.on("error", reject);
    });
    const buffer = readFileSync(tmpFile);
    try { unlinkSync(tmpFile); } catch {}
    return buffer;
}

// ── JID resolution ────────────────────────────────────────────────────────────
function resolveJid(target) {
    if (!target) throw new Error("No target specified");
    if (target.includes("@")) return target;
    const contacts = loadContacts();
    for (const [phone, c] of Object.entries(contacts)) {
        if (c.name?.toLowerCase() === target.toLowerCase()) return `${phone}@s.whatsapp.net`;
    }
    return `${target.replace(/\D/g, "")}@s.whatsapp.net`;
}

// ── wa-out monitor ────────────────────────────────────────────────────────────
// Runs concurrently with a Claude session. Picks up wa-out requests written
// by Claude inside the sandbox and executes them against the WA socket.
function startWaOutMonitor(workspace, replyJid) {
    const dir = join(workspace, ".wa_out");
    mkdirSync(dir, { recursive: true });
    const handled = new Set();

    const interval = setInterval(async () => {
        let files;
        try { files = readdirSync(dir).filter(f => f.endsWith(".req")); }
        catch { return; }

        for (const file of files) {
            const id = file.slice(0, -4);
            if (handled.has(id)) continue;
            handled.add(id);

            const respFile = join(dir, `${id}.resp`);
            try {
                const req  = JSON.parse(readFileSync(join(dir, file), "utf8"));
                const toJid = req.mode === "reply" ? replyJid : resolveJid(req.target);
                if (req.text)  await sock.sendMessage(toJid, { text: req.text });
                if (req.voice) {
                    const audio = await textToSpeech(req.voice);
                    await sock.sendMessage(toJid, { audio, mimetype: "audio/ogg; codecs=opus", ptt: true });
                }
                writeFileSync(respFile, "ok\n");
                console.log(`[wa-out] ${req.mode} → ${toJid}${req.text ? " text" : ""}${req.voice ? " voice" : ""}`);
            } catch (e) {
                console.error("[wa-out]", e.message);
                writeFileSync(respFile, `error: ${e.message}\n`);
            }
        }
    }, 300);

    return () => clearInterval(interval);
}

// ── Reactions & presence ──────────────────────────────────────────────────────
async function react(jid, key, emoji) {
    try { await sock.sendMessage(jid, { react: { text: emoji, key } }); } catch {}
}

async function setTyping(jid, on) {
    try { await sock.sendPresenceUpdate(on ? "composing" : "paused", jid); } catch {}
}

// ── Per-chat queue ────────────────────────────────────────────────────────────
// Messages queue per JID. When Claude finishes a batch, any messages that
// arrived in the meantime are sent together in the next call.

const queues     = new Map(); // jid → [{text, sender}]
const processing = new Set();

function enqueue(jid, entry) {
    if (!queues.has(jid)) queues.set(jid, []);
    queues.get(jid).push(entry);
    if (!processing.has(jid)) processChat(jid).catch(e => console.error("[processChat]", e));
}

function isAdminSender(sender) {
    return ADMIN_NUMBERS.has(sender.replace(/@\S+$/, ""));
}

async function processChat(jid) {
    processing.add(jid);
    try {
        while (queues.get(jid)?.length > 0) {
            const batch   = queues.get(jid).splice(0);
            const admin   = batch.some(m => isAdminSender(m.sender));
            const prompt  = buildPrompt(jid, batch);
            const lastKey = batch[batch.length - 1].key;

            // React 👇 on all but the last message in a batch, 🤔 on the last
            for (const m of batch.slice(0, -1)) { if (m.key) react(jid, m.key, "👇"); }
            if (lastKey) react(jid, lastKey, "🤔");
            setTyping(jid, true);

            try {
                let sessionId = sessions[jid];
                let result;
                try {
                    result = await runClaude(jid, prompt, sessionId, admin);
                } catch (e) {
                    if (sessionId && (e.message.includes("No conversation found with session ID") || e.message.match(/^exit 1:/))) {
                        console.warn(`[claude] ${jid}: stale session ${sessionId}, retrying fresh`);
                        delete sessions[jid];
                        saveSessions();
                        result = await runClaude(jid, prompt, undefined, admin);
                    } else {
                        throw e;
                    }
                }
                if (result.sessionId) { sessions[jid] = result.sessionId; saveSessions(); }
                if (lastKey) react(jid, lastKey, "✅");
            } catch (e) {
                console.error(`[claude] ${jid}:`, e.message);
                logError(e, { jid });
                if (lastKey) react(jid, lastKey, "❌");
            } finally {
                setTyping(jid, false);
            }
        }
    } finally {
        processing.delete(jid);
    }
}

// ── Message text extraction ───────────────────────────────────────────────────
export function extractText(msg) {
    const m = msg.message;
    return m?.conversation
        ?? m?.extendedTextMessage?.text
        ?? (m?.imageMessage    ? (m.imageMessage.caption    ?? "[image]")  : null)
        ?? (m?.videoMessage    ? (m.videoMessage.caption    ?? (m.videoMessage.gifPlayback ? "[GIF]" : "[video]")) : null)
        ?? (m?.audioMessage    ? "[voice message]" : null)
        ?? (m?.documentMessage ? `[document: ${m.documentMessage.fileName ?? "file"}]` : null)
        ?? (m?.stickerMessage  ? "[sticker]" : null)
        ?? (m?.locationMessage ? `[location: ${m.locationMessage.name ?? "shared location"}${m.locationMessage.address ? `, ${m.locationMessage.address}` : ""} (${m.locationMessage.degreesLatitude?.toFixed(4)}, ${m.locationMessage.degreesLongitude?.toFixed(4)})]` : null)
        ?? null;
}

// ── Prompt building ───────────────────────────────────────────────────────────
export function buildPrompt(jid, batch) {
    const contacts    = loadContacts();
    const isGroup     = jid.endsWith("@g.us");
    const voiceCaveat = batch.some(m => m.voiceNote)
        ? "\n[Note: contains transcribed voice note(s) — may have errors, infer from context]"
        : "";

    if (isGroup) {
        const lines = batch.map(m => {
            const c    = contacts[m.sender];
            const name = c ? c.name : m.sender;
            return `${name}: ${m.text}`;
        }).join("\n");
        return `[WhatsApp group ${jid}]${voiceCaveat}\n${lines}`;
    }

    const sender  = batch[0].sender;
    const contact = contacts[sender];
    const header  = contact
        ? `[WhatsApp DM from ${contact.name} (${sender})${contact.description ? ` — ${contact.description}` : ""}]`
        : `[WhatsApp DM from ${sender}]`;
    return `${header}${voiceCaveat}\n${batch.map(m => m.text).join("\n")}`;
}

// ── Claude CLI (sandboxed) ────────────────────────────────────────────────────
function trim80(s) {
    if (!s) return "";
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > 80 ? flat.slice(0, 77) + "…" : flat;
}

function logAgentEvent(jid, ev, t0) {
    const ts = `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
    if (ev.type === "assistant") {
        for (const block of ev.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim())
                console.log(`[agent] ${jid} | ${ts} | text: "${trim80(block.text)}"`);
            if (block.type === "tool_use")
                console.log(`[agent] ${jid} | ${ts} | tool: ${block.name}(${trim80(JSON.stringify(block.input))})`);
        }
    } else if (ev.type === "user") {
        for (const block of ev.message?.content ?? []) {
            if (block.type === "tool_result") {
                const content = Array.isArray(block.content)
                    ? block.content.map(c => c.text ?? "").join(" ")
                    : (block.content ?? "");
                console.log(`[agent] ${jid} | ${ts} | tool_result: "${trim80(content)}"`);
            }
        }
    }
}

function runClaude(jid, prompt, sessionId, admin) {
    return new Promise((resolve, reject) => {
        const safeJid   = jid.replace(/[^a-zA-Z0-9]/g, "_");
        const workspace = `/tmp/claude_sandbox_${safeJid}`;
        const args      = [safeJid, "--permission-mode", admin ? "bypassPermissions" : "dontAsk"];
        if (admin) args.push("--admin");
        if (sessionId) args.push("--resume", sessionId);

        const stopMonitor = startWaOutMonitor(workspace, jid);
        const t0 = Date.now();

        const proc = spawn(SANDBOX_LAUNCH, args, {
            env: { ...process.env, WA_REPLY_JID: jid },
        });
        let buf = "", err = "";
        const parsedLines = [];
        proc.stdout.on("data", d => {
            buf += d;
            const lines = buf.split("\n");
            buf = lines.pop(); // keep incomplete last line
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const ev = JSON.parse(line);
                    parsedLines.push(ev);
                    if (ev.type === "system" && ev.subtype === "init") {
                        const mcp = (ev.mcp_servers ?? []).map(s => `${s.name}:${s.status}`).join(", ");
                        console.log(`[init] ${jid} | mcp: ${mcp || "none"}`);
                    }
                    logAgentEvent(jid, ev, t0);
                } catch {}
            }
        });
        proc.stderr.on("data", d => err += d);
        proc.stdin.write(prompt);
        proc.stdin.end();
        proc.on("close", code => {
            stopMonitor();
            if (code !== 0) return reject(new Error(`exit ${code}: ${err.trim()}`));
            const result  = parseClaudeOutput(parsedLines);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
            const inTok   = result.inputTokens  ?? "?";
            const outTok  = result.outputTokens ?? "?";
            const cliMs  = result.durationMs    != null ? `cli:${(result.durationMs    / 1000).toFixed(2)}s` : null;
            const apiMs  = result.durationApiMs != null ? `api:${(result.durationApiMs / 1000).toFixed(2)}s` : null;
            const timing = [elapsed + "s total", cliMs, apiMs].filter(Boolean).join(" | ");
            console.log(`[perf] ${jid} | ${timing} | ↑${inTok} ↓${outTok} tokens | in: "${trim80(prompt)}" | out: "${trim80(result.text)}"`);
            resolve(result);
        });
        proc.on("error", e => { stopMonitor(); reject(e); });
    });
}

export function parseClaudeOutput(events) {
    for (const d of [...events].reverse()) {
        if (d.type === "result") return {
            text: d.result ?? "",
            sessionId: d.session_id ?? null,
            inputTokens:  d.usage?.input_tokens  ?? null,
            outputTokens: d.usage?.output_tokens ?? null,
            durationMs:   d.duration_ms          ?? null,
            durationApiMs: d.duration_api_ms     ?? null,
        };
    }
    return { text: "", sessionId: null, inputTokens: null, outputTokens: null, durationMs: null, durationApiMs: null };
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────
let sock = null;

async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(join(__dirname, "whatsapp_auth"));
    const { version }          = await fetchLatestBaileysVersion();
    const logger               = pino({ level: "silent" });

    sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
        if (qr) { console.log("\nScan this QR code with WhatsApp:\n"); qrcode.generate(qr, { small: true }); }
        if (connection === "open")  console.log("Connected:", sock.user?.id);
        if (connection === "close") {
            const code   = lastDisconnect?.error?.output?.statusCode;
            const logout = code === DisconnectReason.loggedOut;
            console.log(`Disconnected (${code}). ${logout ? "Logged out." : "Reconnecting..."}`);
            if (!logout) connect();
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        const botJid = sock.user?.id?.replace(/:\d+@/, "@");
        const botLid = sock.user?.lid?.replace(/:\d+@/, "@");

        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const jid = msg.key.remoteJid;
            if (!jid) continue;

            const isGroup   = jid.endsWith("@g.us");
            const rawSender = isGroup ? (msg.key.participant ?? "") : jid;
            const sender    = rawSender.replace(/@\S+$/, "");

            if (process.env.DEBUG_CAPTURE) {
                const text = extractText(msg);
                appendFileSync(
                    join(__dirname, "fixtures", "capture.ndjson"),
                    JSON.stringify(msg) + "\n"
                );
                console.log(`[capture] ${jid} type=${Object.keys(msg.message ?? {}).join(",")} text=${JSON.stringify(text)}`);
                continue;
            }

            const isVoiceNote = msg.message?.audioMessage != null;
            if (isVoiceNote) {
                if (isGroup && GROUP_MENTION_ONLY) continue;
                react(jid, msg.key, "👀");
                transcribeVoiceNote(msg)
                    .then(text => enqueue(jid, { text: `[voice note: "${text}"]`, sender, voiceNote: true, key: msg.key }))
                    .catch(e => {
                        console.error(`[transcribe] ${jid}:`, e.message);
                        enqueue(jid, { text: "[voice note: transcription failed]", sender, voiceNote: true, key: msg.key });
                    });
                continue;
            }

            let text;
            if (msg.message?.imageMessage) {
                const safeJid   = jid.replace(/[^a-zA-Z0-9]/g, "_");
                const workspace = join("/tmp", `claude_sandbox_${safeJid}`);
                try {
                    mkdirSync(workspace, { recursive: true });
                    const freshMsg = await sock.updateMediaMessage(msg).catch(ue => {
                        console.error(`[image] ${jid}: updateMediaMessage failed:`, ue.message);
                        return msg;
                    });
                    const buffer   = await downloadMediaMessage(freshMsg, "buffer", {},
                        { logger: pino({ level: "silent" }), reuploadRequest: m => sock.updateMediaMessage(m) });
                    const fname    = `image_${Date.now()}.jpg`;
                    writeFileSync(join(workspace, fname), buffer);
                    const imgPath  = isAdminSender(sender) ? join(workspace, fname) : `/workspace/${fname}`;
                    const caption  = msg.message.imageMessage.caption;
                    text = `[image: ${imgPath}${caption ? `  caption: "${caption}"` : ""}]`;
                    console.log(`[image] ${jid}: saved ${fname} (${buffer.length} bytes)`);
                } catch (e) {
                    console.error(`[image] ${jid}:`, e.message);
                    console.error(`[image] ${jid}: cause=`, e.cause);
                    console.error(`[image] ${jid}: stack=`, e.stack?.split("\n").slice(0,4).join(" | "));
                    text = extractText(msg);
                }
            } else {
                text = extractText(msg);
            }

            if (!text) continue;

            if (isGroup && GROUP_MENTION_ONLY) {
                const inner      = Object.values(msg.message ?? {})[0];
                const mentioned  = inner?.contextInfo?.mentionedJid ?? [];
                const normalised = j => j.replace(/:\d+@/, "@");
                if (!mentioned.some(j => normalised(j) === botJid || normalised(j) === botLid)) continue;
            }

            react(jid, msg.key, "👀");
            enqueue(jid, { text, sender, key: msg.key });
        }
    });
}

connect();
