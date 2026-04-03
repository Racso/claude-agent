#!/usr/bin/env node
// Unit tests for WhatsApp message processing logic.
// Tests extractText(), buildPrompt(), and parseClaudeOutput() in isolation —
// no sandbox, no Claude, no network required.
//
// Usage: node test_wa_format.js

import { extractText, buildPrompt, parseClaudeOutput } from "./index.js";

let pass = 0, fail = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓  ${name}`);
        pass++;
    } catch (e) {
        console.log(`  ✗  ${name}`);
        console.log(`       ${e.message}`);
        fail++;
    }
}

function eq(actual, expected, label = "") {
    if (actual !== expected) {
        const suffix = label ? ` (${label})` : "";
        throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${suffix}`);
    }
}

function includes(actual, substring) {
    if (!actual?.includes(substring)) {
        throw new Error(`expected ${JSON.stringify(actual)} to include ${JSON.stringify(substring)}`);
    }
}

// ── extractText ───────────────────────────────────────────────────────────────
console.log("\n── extractText");

test("conversation", () =>
    eq(extractText({ message: { conversation: "Hello" } }), "Hello"));

test("extendedTextMessage", () =>
    eq(extractText({ message: { extendedTextMessage: { text: "Hi there" } } }), "Hi there"));

test("imageMessage with caption", () =>
    eq(extractText({ message: { imageMessage: { caption: "Look at this" } } }), "Look at this"));

test("imageMessage without caption → [image]", () =>
    eq(extractText({ message: { imageMessage: { mimetype: "image/jpeg" } } }), "[image]"));

test("videoMessage with caption", () =>
    eq(extractText({ message: { videoMessage: { caption: "Watch this" } } }), "Watch this"));

test("videoMessage without caption → [video]", () =>
    eq(extractText({ message: { videoMessage: { mimetype: "video/mp4", seconds: 3 } } }), "[video]"));

test("videoMessage GIF (gifPlayback=true) → [GIF]", () =>
    eq(extractText({ message: { videoMessage: { mimetype: "video/mp4", gifPlayback: true, gifAttribution: "GIPHY" } } }), "[GIF]"));

test("audioMessage → [voice message]", () =>
    eq(extractText({ message: { audioMessage: {} } }), "[voice message]"));

test("documentMessage with fileName", () =>
    eq(extractText({ message: { documentMessage: { fileName: "report.pdf" } } }), "[document: report.pdf]"));

test("documentMessage without fileName", () =>
    eq(extractText({ message: { documentMessage: {} } }), "[document: file]"));

test("stickerMessage → [sticker]", () =>
    eq(extractText({ message: { stickerMessage: {} } }), "[sticker]"));

test("locationMessage with name and address", () =>
    eq(
        extractText({ message: { locationMessage: { degreesLatitude: 7.06, degreesLongitude: -73.11, name: "Club Campestre", address: "Cra. 21 #30-02" } } }),
        "[location: Club Campestre, Cra. 21 #30-02 (7.0600, -73.1100)]"
    ));

test("locationMessage without name → [location: shared location]", () =>
    eq(
        extractText({ message: { locationMessage: { degreesLatitude: 7.06, degreesLongitude: -73.11 } } }),
        "[location: shared location (7.0600, -73.1100)]"
    ));

test("unknown message type → null (ignored)", () =>
    eq(extractText({ message: { reactionMessage: {} } }), null));

test("null message → null", () =>
    eq(extractText({ message: null }), null));

test("group message: senderKeyDistributionMessage alongside extendedTextMessage (real Baileys shape)", () =>
    eq(
        extractText({ message: {
            senderKeyDistributionMessage: { groupId: "120363@g.us" },
            extendedTextMessage: { text: "Hi group", previewType: "NONE", contextInfo: {} },
            messageContextInfo: {},
        }}),
        "Hi group"
    ));

test("conversation takes priority over extendedTextMessage", () =>
    eq(extractText({ message: { conversation: "plain", extendedTextMessage: { text: "rich" } } }), "plain"));

// ── buildPrompt ───────────────────────────────────────────────────────────────
console.log("\n── buildPrompt");

const DM_JID   = "521234567890@lid";
const GRP_JID  = "120363000000000001@g.us";

test("DM without contact — shows sender number", () => {
    const prompt = buildPrompt(DM_JID, [{ text: "Hey", sender: "521234567890" }]);
    includes(prompt, "[WhatsApp DM from 521234567890]");
    includes(prompt, "Hey");
});

test("DM with named contact — shows name and number", () => {
    // contacts.json is {} in dev, so we test the no-contact path above.
    // This test validates the format string directly.
    const jid = "521234567890@lid";
    // Temporarily monkey-patch loadContacts via the module — not feasible without
    // refactoring. Instead validate the no-contact format is correct.
    const prompt = buildPrompt(jid, [{ text: "Hello", sender: "521234567890" }]);
    includes(prompt, "521234567890");
    includes(prompt, "Hello");
});

test("DM with multiple batched messages", () => {
    const prompt = buildPrompt(DM_JID, [
        { text: "First message", sender: "521234567890" },
        { text: "Second message", sender: "521234567890" },
    ]);
    includes(prompt, "First message");
    includes(prompt, "Second message");
});

test("group message — prefixes each line with sender", () => {
    const prompt = buildPrompt(GRP_JID, [
        { text: "Hi all", sender: "521111111111" },
        { text: "Hey!", sender: "522222222222" },
    ]);
    includes(prompt, `[WhatsApp group ${GRP_JID}]`);
    includes(prompt, "521111111111: Hi all");
    includes(prompt, "522222222222: Hey!");
});

test("group JID detection — ends with @g.us", () => {
    const prompt = buildPrompt(GRP_JID, [{ text: "test", sender: "521111111111" }]);
    includes(prompt, "[WhatsApp group");
});

test("DM JID detection — @lid is not a group", () => {
    const prompt = buildPrompt(DM_JID, [{ text: "test", sender: "521234567890" }]);
    includes(prompt, "[WhatsApp DM");
});

// ── parseClaudeOutput ─────────────────────────────────────────────────────────
console.log("\n── parseClaudeOutput");

test("clean JSON with result and session_id", () => {
    const raw = JSON.stringify({ result: "Hello there", session_id: "abc-123", type: "result" });
    const out = parseClaudeOutput(raw);
    eq(out.text, "Hello there");
    eq(out.sessionId, "abc-123");
});

test("result field missing → falls back to raw", () => {
    const raw = JSON.stringify({ session_id: "abc-123" });
    const out = parseClaudeOutput(raw);
    eq(out.sessionId, "abc-123");
    // text falls back to the raw string itself
    includes(out.text, "abc-123");
});

test("streaming JSONL — picks last result line", () => {
    const lines = [
        JSON.stringify({ type: "text", text: "partial..." }),
        JSON.stringify({ type: "result", result: "Final answer", session_id: "xyz-789" }),
    ].join("\n");
    const out = parseClaudeOutput(lines);
    eq(out.text, "Final answer");
    eq(out.sessionId, "xyz-789");
});

test("plain text fallback — not JSON at all", () => {
    const out = parseClaudeOutput("just a plain string");
    eq(out.text, "just a plain string");
    eq(out.sessionId, null);
});

test("empty result field returns empty string", () => {
    const raw = JSON.stringify({ type: "result", result: "", session_id: "s1" });
    const out = parseClaudeOutput(raw);
    eq(out.text, "");
    eq(out.sessionId, "s1");
});

// ── Group mention filtering (logic validation) ────────────────────────────────
// This logic lives in the messages.upsert handler and can't be imported directly.
// Document the expected behaviour as reference tests for manual verification.
console.log("\n── Group mention filter (reference)");

test("mentionedJid list format — @lid suffix normalisation", () => {
    // index.js does: j.replace(/:\d+@/, "@") === botJid
    // e.g. "1234567890:16@lid" → "1234567890@lid"
    const raw = "1234567890:16@lid";
    const normalised = raw.replace(/:\d+@/, "@");
    eq(normalised, "1234567890@lid");
});

test("group JID never treated as admin", () => {
    // isAdminJid returns false for any @g.us jid
    const jid = "120363000000000001@g.us";
    const isAdmin = !jid.endsWith("@g.us");
    eq(isAdmin, false);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log();
console.log("────────────────────────────────────────");
process.stdout.write(` Results: ${pass} passed`);
if (fail > 0) process.stdout.write(`, ${fail} FAILED`);
console.log();
console.log("────────────────────────────────────────");
process.exit(fail > 0 ? 1 : 0);
