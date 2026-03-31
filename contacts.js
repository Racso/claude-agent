#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname     = dirname(fileURLToPath(import.meta.url));
const CONTACTS_FILE = process.env.CONTACTS_FILE ?? join(__dirname, "contacts.json");

function load() {
    if (!existsSync(CONTACTS_FILE)) return {};
    try { return JSON.parse(readFileSync(CONTACTS_FILE, "utf8")); } catch { return {}; }
}

function save(data) {
    writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2));
}

function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("--") && i + 1 < args.length)
            flags[args[i].slice(2)] = args[++i];
    }
    return flags;
}

function out(obj) { console.log(JSON.stringify(obj, null, 2)); }

const [,, cmd, ...rest] = process.argv;
const contacts = load();

switch (cmd) {
    case "add":
    case "edit": {
        const { phone, name, description } = parseFlags(rest);
        if (!phone) { out({ error: "Missing --phone" }); process.exit(1); }
        if (cmd === "edit" && !contacts[phone]) { out({ error: `Contact not found: ${phone}` }); process.exit(1); }
        contacts[phone] = {
            name:        name        ?? contacts[phone]?.name        ?? "",
            description: description ?? contacts[phone]?.description ?? "",
        };
        save(contacts);
        out({ ok: true, contact: { phone, ...contacts[phone] } });
        break;
    }
    case "remove": {
        const { phone } = parseFlags(rest);
        if (!phone || !contacts[phone]) { out({ error: `Contact not found: ${phone}` }); process.exit(1); }
        const removed = contacts[phone];
        delete contacts[phone];
        save(contacts);
        out({ ok: true, removed: { phone, ...removed } });
        break;
    }
    case "get": {
        const { phone } = parseFlags(rest);
        const contact = contacts[phone];
        if (!contact) { out({ error: `Contact not found: ${phone}` }); process.exit(1); }
        out({ phone, ...contact });
        break;
    }
    case "list": {
        out(Object.entries(contacts).map(([phone, c]) => ({ phone, ...c })));
        break;
    }
    default:
        out({ error: `Unknown command: ${cmd}. Available: add, edit, remove, get, list` });
        process.exit(1);
}
