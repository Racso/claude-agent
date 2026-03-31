#!/usr/bin/env node
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pino from "pino";
import { parse as parseToml } from "smol-toml";

const __dirname          = dirname(fileURLToPath(import.meta.url));
const SESS_FILE          = join(__dirname, "sessions.json");
const CONTACTS_FILE      = join(__dirname, "contacts.json");
const CONTACTS_BIN_SANDBOX = "/claude_wa/contacts.js"; // path inside bwrap
const SANDBOX_LAUNCH     = join(__dirname, "sandbox", "launch");

// ── Config ────────────────────────────────────────────────────────────────────
const config             = parseToml(readFileSync(join(__dirname, "config.toml"), "utf8"));
const ADMIN_NUMBERS      = new Set(config.admins?.numbers ?? []);
const GROUP_MENTION_ONLY = config.settings?.group_mention_only ?? true;

// ── Public system prompt ──────────────────────────────────────────────────────
const PUBLIC_SYSTEM_PROMPT = `\
You are Índigo, a personal assistant to Óscar F. Gómez, communicating on his behalf via WhatsApp.

Be professional, warm, and neutral. Clear and well-structured. No irony or sarcasm. Always respond in the user's language.

You have access to one tool — a contacts manager — which you may invoke via Bash:

  node ${CONTACTS_BIN_SANDBOX} add --phone <phone> --name "<name>" --description "<description>"
  node ${CONTACTS_BIN_SANDBOX} edit --phone <phone> --name "<name>" --description "<description>"
  node ${CONTACTS_BIN_SANDBOX} remove --phone <phone>
  node ${CONTACTS_BIN_SANDBOX} get --phone <phone>
  node ${CONTACTS_BIN_SANDBOX} list

All commands output JSON. Phone numbers are digits only (e.g. 521234567890). Use this tool when someone introduces themselves or asks to be remembered.

All other tools (file system, web search, command execution, etc.) are unavailable and will be automatically denied. Do not attempt to use them. When a request requires capabilities you don't have, respond conversationally and explain.`;

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

function isAdminJid(jid) {
    if (jid.endsWith("@g.us")) return false;
    return ADMIN_NUMBERS.has(jid.replace(/@\S+$/, ""));
}

async function processChat(jid) {
    processing.add(jid);
    const admin = isAdminJid(jid);
    try {
        while (queues.get(jid)?.length > 0) {
            const batch  = queues.get(jid).splice(0);
            const prompt = buildPrompt(jid, batch);
            try {
                const { text, sessionId } = await runClaude(jid, prompt, sessions[jid], admin);
                if (sessionId) { sessions[jid] = sessionId; saveSessions(); }
                if (text) await sock.sendMessage(jid, { text });
            } catch (e) {
                console.error(`[claude] ${jid}:`, e.message);
                try { await sock.sendMessage(jid, { text: "[Error processing message. Please try again.]" }); } catch {}
            }
        }
    } finally {
        processing.delete(jid);
    }
}

// ── Prompt building ───────────────────────────────────────────────────────────
function buildPrompt(jid, batch) {
    const contacts = loadContacts();
    const isGroup  = jid.endsWith("@g.us");

    if (isGroup) {
        const lines = batch.map(m => {
            const c    = contacts[m.sender];
            const name = c ? c.name : m.sender;
            return `${name}: ${m.text}`;
        }).join("\n");
        return `[WhatsApp group ${jid}]\n${lines}`;
    }

    const sender  = batch[0].sender;
    const contact = contacts[sender];
    const header  = contact
        ? `[WhatsApp DM from ${contact.name} (${sender})${contact.description ? ` — ${contact.description}` : ""}]`
        : `[WhatsApp DM from ${sender}]`;
    return `${header}\n${batch.map(m => m.text).join("\n")}`;
}

// ── Claude CLI (sandboxed) ────────────────────────────────────────────────────
function runClaude(jid, prompt, sessionId, admin) {
    return new Promise((resolve, reject) => {
        const safeJid = jid.replace(/[^a-zA-Z0-9]/g, "_");
        const args = [
            safeJid,
            "--permission-mode", admin ? "bypassPermissions" : "dontAsk",
        ];
        if (!admin) args.push("--system-prompt", PUBLIC_SYSTEM_PROMPT);
        if (sessionId) args.push("--resume", sessionId);

        const proc = spawn(SANDBOX_LAUNCH, args);
        let out = "", err = "";
        proc.stdout.on("data", d => out += d);
        proc.stderr.on("data", d => err += d);
        proc.stdin.write(prompt);
        proc.stdin.end();
        proc.on("close", code => {
            if (code !== 0) return reject(new Error(`exit ${code}: ${err.trim()}`));
            resolve(parseClaudeOutput(out));
        });
        proc.on("error", reject);
    });
}

function parseClaudeOutput(raw) {
    try {
        const d = JSON.parse(raw.trim());
        return { text: d.result ?? raw.trim(), sessionId: d.session_id ?? null };
    } catch {}
    for (const line of raw.trim().split("\n").reverse()) {
        try {
            const d = JSON.parse(line);
            if (d.type === "result") return { text: d.result ?? "", sessionId: d.session_id ?? null };
        } catch {}
    }
    return { text: raw.trim(), sessionId: null };
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

        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const jid = msg.key.remoteJid;
            if (!jid) continue;

            const isGroup   = jid.endsWith("@g.us");
            const rawSender = isGroup ? (msg.key.participant ?? "") : jid;
            const sender    = rawSender.replace(/@\S+$/, "");

            const m = msg.message;
            const text =
                m?.conversation
                ?? m?.extendedTextMessage?.text
                ?? m?.imageMessage?.caption
                ?? m?.videoMessage?.caption
                ?? (m?.audioMessage    ? "[voice message]" : null)
                ?? (m?.documentMessage ? `[document: ${m.documentMessage.fileName ?? "file"}]` : null)
                ?? (m?.stickerMessage  ? "[sticker]" : null)
                ?? null;

            if (!text) continue;

            if (isGroup && GROUP_MENTION_ONLY) {
                const mentioned = m?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
                if (!mentioned.some(j => j.replace(/:\d+@/, "@") === botJid)) continue;
            }

            enqueue(jid, { text, sender });
        }
    });
}

connect();
