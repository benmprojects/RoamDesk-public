// Minimal MCP server (stdio): lets Claude hand a file from this PC to the user's phone or browser, and ask the user to
// choose between options in the web client. No dependencies. It only talks to the local helper, which does the
// copying, the policy check and the delivery.
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "send_file",
    description:
      "Send a file from this PC to the user's phone. It appears as a card in the Roam Desk conversation, where the user can open, " +
      "share or save it. Use it whenever the user asks you to send, show, or give them a file, document, spreadsheet, PDF, image or export. " +
      "Pass the full path. Folders can't be sent: zip them first.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Full path of the file on this PC, e.g. C:\\Users\\me\\Downloads\\report.pdf" },
        caption: { type: "string", description: "Optional short note shown with the file" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user to choose between options; they see the choices as buttons in the Roam Desk web client and the answer comes back to you. " +
      "Use it when you need a decision with clear alternatives (which approach, which file, yes or no on a risky choice). Up to 4 questions, " +
      "each with 2 to 8 options. The user can also type their own answer. Not available when the user is on their phone: then ask in your reply.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The full question, ending with a question mark." },
              header: { type: "string", description: "Very short label (up to 12 characters), e.g. \"Approach\"." },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 8,
                items: {
                  type: "object",
                  properties: { label: { type: "string" }, description: { type: "string", description: "What choosing this means." } },
                  required: ["label"],
                },
              },
              multiSelect: { type: "boolean", description: "Allow more than one option." },
            },
            required: ["question", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
];

async function askUser(args) {
  const hook = process.env.CA_HOOK_URL;
  const key = process.env.CA_HOOK_KEY;
  if (!hook || !key) return { ok: false, text: "The helper link isn't configured." };
  try {
    const res = await fetch(hook.replace(/\/hook\/pretool$/, "/hook/ask"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-ca-token": key },
      body: JSON.stringify({ sessionId: process.env.CA_SESSION_ID, questions: args.questions }),
      signal: AbortSignal.timeout(870_000),
    });
    const r = await res.json();
    if (!res.ok || !r.ok) return { ok: false, text: String(r.error ?? `The helper answered ${res.status}`) };
    const lines = Object.entries(r.answers).map(([q, a]) => `"${q}" = "${a}"`);
    return { ok: true, text: `The user answered: ${lines.join("; ")}. Carry on with these answers in mind.` };
  } catch (e) {
    return { ok: false, text: `Couldn't reach the helper (${e?.name ?? "error"}).` };
  }
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function sendFile(args) {
  const hook = process.env.CA_HOOK_URL;
  const key = process.env.CA_HOOK_KEY;
  if (!hook || !key) return { ok: false, text: "The phone link isn't configured." };
  const url = hook.replace(/\/hook\/pretool$/, "/hook/send-file");
  const path = String(args.file_path ?? args.path ?? args.filePath ?? "").trim();
  if (!path) return { ok: false, text: "No file path was given. Pass the file's full path as file_path." };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ca-token": key },
      body: JSON.stringify({ sessionId: process.env.CA_SESSION_ID, path, caption: args.caption ?? "" }),
      signal: AbortSignal.timeout(120_000),
    });
    const r = await res.json();
    if (!res.ok || !r.ok) return { ok: false, text: String(r.error ?? `The helper answered ${res.status}`) };
    return { ok: true, text: `Sent ${r.name} (${Math.max(1, Math.round(r.size / 1024))} KB) to the user's phone. It is in the app's conversation.` };
  } catch (e) {
    return { ok: false, text: `Couldn't reach the helper (${e?.name ?? "error"}).` };
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (id === undefined) return;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "phone", version: "1.0.0" } } });
  }
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call" && params?.name === "send_file") {
    const r = await sendFile(params.arguments ?? {});
    return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: r.text }], isError: !r.ok } });
  }
  if (method === "tools/call" && params?.name === "ask_user") {
    const r = await askUser(params.arguments ?? {});
    return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: r.text }], isError: !r.ok } });
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
});
