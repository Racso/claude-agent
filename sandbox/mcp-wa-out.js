#!/usr/bin/env node
// MCP stdio server — exposes wa_out as a native Claude tool.
// Spawned by Claude Code per session; inherits WA_OUT_DIR from the environment.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const WA_OUT_DIR = process.env.WA_OUT_DIR ?? "/workspace/.wa_out";

const server = new McpServer({
    name: "wa-out",
    version: "1.0.0",
});

server.tool(
    "wa_out",
    "Send a WhatsApp message. " +
    "This is the ONLY way to deliver responses to the user — every reply MUST go through this tool. " +
    "Use mode='reply' to respond to the current conversation. " +
    "Combine text and voice in a single call when both formats are needed.",
    {
        mode:   z.enum(["reply", "send"]).describe("'reply' sends to the conversation that triggered this session; 'send' sends to a specific target."),
        target: z.string().optional().describe("Required when mode='send'. Phone number, JID, or contact name."),
        text:   z.string().optional().describe("Text message to send."),
        voice:  z.string().optional().describe("Text to convert to a voice note and send."),
    },
    async ({ mode, target = "", text = "", voice = "" }) => {
        if (!text && !voice) return { content: [{ type: "text", text: "Error: text or voice is required" }], isError: true };
        if (mode === "send" && !target) return { content: [{ type: "text", text: "Error: target is required when mode=send" }], isError: true };

        mkdirSync(WA_OUT_DIR, { recursive: true });
        const id       = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const reqFile  = join(WA_OUT_DIR, `${id}.req`);
        const respFile = join(WA_OUT_DIR, `${id}.resp`);

        writeFileSync(reqFile, JSON.stringify({ id, mode, target, text, voice }));

        // Wait for host response — 30s timeout
        const deadline = Date.now() + 30_000;
        await new Promise((resolve, reject) => {
            const poll = setInterval(() => {
                if (existsSync(respFile)) {
                    clearInterval(poll);
                    const status = readFileSync(respFile, "utf8").trim();
                    status === "ok" ? resolve() : reject(new Error(status));
                } else if (Date.now() > deadline) {
                    clearInterval(poll);
                    reject(new Error("wa_out: timed out waiting for host"));
                }
            }, 100);
        });

        return { content: [{ type: "text", text: "ok" }] };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
