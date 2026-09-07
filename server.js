// AI Coding App - local agent backend
// Free, on-machine. Talks to OpenRouter, runs a tool loop, streams to the UI.
const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");

// ---------- Load config from ~/.qwen/.env (reuses the key you already saved) ----------
function loadEnv() {
  const envPath = path.join(os.homedir(), ".qwen", ".env");
  const cfg = {};
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith("#")) cfg[m[1]] = m[2].trim();
    }
  } catch (e) {
    console.error("Could not read ~/.qwen/.env:", e.message);
  }
  return cfg;
}
const ENV = loadEnv();
const API_KEY = ENV.OPENAI_API_KEY || "";
const BASE_URL = (ENV.OPENAI_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const MODEL = ENV.OPENAI_MODEL || "minimax/minimax-m3:free";

// ---------- State ----------
const DEFAULT_CWD = path.join(__dirname, "workspace");
try { fs.mkdirSync(DEFAULT_CWD, { recursive: true }); } catch {} // ensure default cwd exists
let workingDir = DEFAULT_CWD;
let history = []; // conversation messages
const pendingApprovals = new Map(); // id -> resolve fn

const SYSTEM_PROMPT = `You are a coding agent running locally on the user's Windows machine.
You help by reading and editing files and running commands inside the working directory.
Use the provided tools to inspect and change files rather than guessing.
Be concise and direct. When you finish a task, briefly say what you did.
Prefer small, verifiable steps. The current working directory is provided with each task.`;

// ---------- Tools ----------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders in a directory (relative to the working directory).",
      parameters: { type: "object", properties: { dir: { type: "string", description: "Relative path, '.' for root" } }, required: ["dir"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file's contents.",
      parameters: { type: "object", properties: { file: { type: "string", description: "Relative path to the file" } }, required: ["file"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a text file with the given content.",
      parameters: { type: "object", properties: { file: { type: "string" }, content: { type: "string" } }, required: ["file", "content"] },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the working directory. Requires user approval.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
];

function safeResolve(rel) {
  const target = path.resolve(workingDir, rel || ".");
  const root = path.resolve(workingDir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Path is outside the working directory: " + rel);
  }
  return target;
}

function execCommand(command) {
  return new Promise((resolve) => {
    exec(command, { cwd: workingDir, timeout: 120000, maxBuffer: 1024 * 1024 * 5, windowsHide: true }, (err, stdout, stderr) => {
      let out = (stdout || "") + (stderr ? "\n" + stderr : "");
      if (err && !stdout && !stderr) out = String(err.message);
      if (out.length > 15000) out = out.slice(0, 15000) + "\n...[truncated]";
      resolve(out || "(no output)");
    });
  });
}

async function runTool(name, args, emit) {
  try {
    if (name === "list_dir") {
      const dir = safeResolve(args.dir || ".");
      const items = fs.readdirSync(dir, { withFileTypes: true })
        .map((d) => (d.isDirectory() ? d.name + "/" : d.name));
      return items.length ? items.join("\n") : "(empty)";
    }
    if (name === "read_file") {
      const f = safeResolve(args.file);
      const data = fs.readFileSync(f, "utf8");
      return data.length > 30000 ? data.slice(0, 30000) + "\n...[truncated]" : data;
    }
    if (name === "write_file") {
      const f = safeResolve(args.file);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, args.content ?? "", "utf8");
      return "Wrote " + args.file + " (" + (args.content ? args.content.length : 0) + " bytes)";
    }
    if (name === "run_command") {
      // Ask the UI for approval first
      const id = Math.random().toString(36).slice(2);
      emit({ type: "approval", id, command: args.command });
      const approved = await new Promise((resolve) => pendingApprovals.set(id, resolve));
      if (!approved) return "Command denied by user.";
      emit({ type: "command_running", command: args.command });
      const out = await execCommand(args.command);
      return out;
    }
    return "Unknown tool: " + name;
  } catch (e) {
    return "ERROR: " + e.message;
  }
}

// ---------- Model call ----------
const MODEL_TIMEOUT_MS = 180000; // abort a hung request instead of freezing the loop
async function callModel(messages) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MODEL_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + API_KEY,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8787",
        "X-Title": "AI Coding App",
      },
      body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: "auto" }),
      signal: ac.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Model request timed out after ${MODEL_TIMEOUT_MS / 1000}s`);
    throw new Error("Network error calling model: " + e.message);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Model returned non-JSON (HTTP ${res.status}): ` + text.slice(0, 300)); }
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  if (!res.ok) throw new Error(`Model HTTP ${res.status}: ` + text.slice(0, 300));
  if (!data.choices || !data.choices[0]) throw new Error("No response from model: " + JSON.stringify(data).slice(0, 300));
  return data.choices[0].message;
}

// ---------- Agent loop ----------
async function agentLoop(userMessage, emit) {
  history.push({ role: "user", content: userMessage });
  const messages = [
    { role: "system", content: SYSTEM_PROMPT + "\nWorking directory: " + workingDir },
    ...history,
  ];

  for (let i = 0; i < 25; i++) {
    emit({ type: "thinking" });
    const msg = await callModel(messages);
    messages.push(msg);
    history.push(msg);

    if (msg.tool_calls && msg.tool_calls.length) {
      if (msg.content) emit({ type: "assistant", content: msg.content });
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        emit({ type: "tool_call", name: tc.function.name, args });
        const result = await runTool(tc.function.name, args, emit);
        emit({ type: "tool_result", name: tc.function.name, result });
        const toolMsg = { role: "tool", tool_call_id: tc.id, content: String(result) };
        messages.push(toolMsg);
        history.push(toolMsg);
      }
      continue; // let the model react to tool results
    }

    // Final answer
    emit({ type: "assistant", content: msg.content || "(done)" });
    emit({ type: "done" });
    return;
  }
  emit({ type: "assistant", content: "Stopped after 25 steps to avoid a loop." });
  emit({ type: "done" });
}

// ---------- Server ----------
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", (req, res) => {
  res.json({ model: MODEL, baseUrl: BASE_URL, hasKey: !!API_KEY, cwd: workingDir, defaultCwd: DEFAULT_CWD });
});

app.post("/api/setcwd", (req, res) => {
  const p = (req.body.cwd || "").trim();
  if (!p) { workingDir = DEFAULT_CWD; return res.json({ cwd: workingDir }); }
  try {
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return res.status(400).json({ error: "Not a folder: " + resolved });
    }
    workingDir = resolved;
    res.json({ cwd: workingDir });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/reset", (req, res) => { history = []; res.json({ ok: true }); });

app.post("/api/approve", (req, res) => {
  const { id, approved } = req.body;
  const resolve = pendingApprovals.get(id);
  if (resolve) { pendingApprovals.delete(id); resolve(!!approved); res.json({ ok: true }); }
  else res.status(404).json({ error: "No pending approval" });
});

let chatBusy = false; // prevent overlapping agent loops from corrupting shared history
app.post("/api/chat", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  const emit = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch {} };
  if (chatBusy) {
    emit({ type: "error", message: "A task is already running. Wait for it to finish before sending another." });
    return res.end();
  }
  chatBusy = true;
  try {
    if (!API_KEY) { emit({ type: "error", message: "No API key found in ~/.qwen/.env" }); return res.end(); }
    await agentLoop(req.body.message || "", emit);
  } catch (e) {
    emit({ type: "error", message: e.message });
  } finally {
    chatBusy = false;
    res.end();
  }
});

const PORT = 8787;
app.listen(PORT, () => {
  console.log("\n  AI Coding App running:  http://localhost:" + PORT);
  console.log("  Model:", MODEL);
  console.log("  Working dir:", workingDir);
  console.log("  Key loaded:", API_KEY ? "yes" : "NO - check ~/.qwen/.env\n");
});
