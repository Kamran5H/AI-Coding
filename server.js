// AI Coding App - local agent backend
// Runs on this computer only. Engines: OpenRouter (built-in tool loop) or the
// official Claude / ChatGPT / Gemini command-line tools signed in to your own plans.
const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { exec } = require("child_process");
const { localOnly } = require("./lib/guard");
const engines = require("./lib/engines");

// ---------- Config: ./.env first, then ~/.qwen/.env (reuses a key you already saved) ----------
function parseEnv(raw) {
  const cfg = {};
  for (const line of String(raw).split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in cfg)) cfg[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return cfg;
}
function loadEnv() {
  const cfg = {};
  for (const envPath of [path.join(__dirname, ".env"), path.join(os.homedir(), ".qwen", ".env")]) {
    try {
      if (!fs.existsSync(envPath)) continue;
      for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(envPath, "utf8")))) if (!(k in cfg)) cfg[k] = v;
    } catch (e) {
      console.error("Could not read " + envPath + ":", e.message);
    }
  }
  return cfg;
}
const ENV = loadEnv();
const pick = (...names) => { for (const n of names) { const v = process.env[n] || ENV[n]; if (v) return v; } return ""; };
// Both spellings are accepted: the README used OPENROUTER_API_KEY / MODEL / PORT
// while the code only read OPENAI_*, so a key set "by the book" was ignored.
const API_KEY = pick("OPENAI_API_KEY", "OPENROUTER_API_KEY");
const BASE_URL = (pick("OPENAI_BASE_URL", "OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const MODEL = pick("OPENAI_MODEL", "MODEL") || "minimax/minimax-m3:free";
const PORT = Number(pick("PORT")) || 8787;

// ---------- State ----------
const DEFAULT_CWD = path.join(__dirname, "workspace");
try { fs.mkdirSync(DEFAULT_CWD, { recursive: true }); } catch {}
let workingDir = DEFAULT_CWD;
let history = [];                    // OpenRouter conversation (API message objects)
let transcript = [];                 // plain {role, text} turns, shared by every engine
const pendingApprovals = new Map();  // id -> resolve fn
const MAX_HISTORY_MESSAGES = 80;
const MAX_STEPS = 25;

const SYSTEM_PROMPT = `You are a coding agent running locally on the user's machine.
You help by reading and editing files and running commands inside the working directory.
Use the provided tools to inspect and change files rather than guessing.
Be concise and direct. When you finish a task, briefly say what you did.
Prefer small, verifiable steps. The current working directory is provided with each task.`;

// ---------- Tools ----------
const TOOLS = [
  { type: "function", function: { name: "list_dir", description: "List files and folders in a directory (relative to the working directory).",
      parameters: { type: "object", properties: { dir: { type: "string", description: "Relative path, '.' for root" } }, required: ["dir"] } } },
  { type: "function", function: { name: "read_file", description: "Read a text file's contents.",
      parameters: { type: "object", properties: { file: { type: "string", description: "Relative path to the file" } }, required: ["file"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a text file with the given content.",
      parameters: { type: "object", properties: { file: { type: "string" }, content: { type: "string" } }, required: ["file", "content"] } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command in the working directory. Requires user approval.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
];

function isInside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

// Resolve a path the model asked for, refusing anything outside the working
// folder. The textual check alone is not enough: a link inside the folder that
// points outside it (a symlink or Windows junction) would pass, so the real
// location of the deepest existing parent is checked as well.
function safeResolve(rel, root = workingDir) {
  if (typeof rel !== "string" && rel !== undefined && rel !== null) throw new Error("Path must be text.");
  const base = path.resolve(root);
  const target = path.resolve(base, rel || ".");
  if (!isInside(base, target)) throw new Error("Path is outside the working directory: " + rel);
  let realBase = base;
  try { realBase = fs.realpathSync(base); } catch {}
  let probe = target;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  let realProbe = probe;
  try { realProbe = fs.realpathSync(probe); } catch {}
  if (!isInside(realBase, realProbe)) throw new Error("Path leaves the working directory through a link: " + rel);
  return target;
}

function execCommand(command, cwd = workingDir) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 120000, maxBuffer: 1024 * 1024 * 5, windowsHide: true }, (err, stdout, stderr) => {
      let out = (stdout || "") + (stderr ? "\n" + stderr : "");
      if (err && err.killed) out += "\n[stopped: the command ran longer than 2 minutes]";
      else if (err && !stdout && !stderr) out = String(err.message);
      else if (err && typeof err.code === "number") out += `\n[exit code ${err.code}]`;
      if (out.length > 15000) out = out.slice(0, 15000) + "\n...[truncated]";
      resolve(out || "(no output)");
    });
  });
}

function requestApproval(command, emit, signal) {
  const id = crypto.randomUUID();
  emit({ type: "approval", id, command });
  return new Promise((resolve) => {
    const settle = (ok) => { if (pendingApprovals.delete(id)) resolve(ok); };
    pendingApprovals.set(id, settle);
    // If the browser tab goes away or the task is stopped, nobody can answer:
    // treat it as "no" instead of leaving the app busy forever.
    if (signal) signal.addEventListener("abort", () => settle(false), { once: true });
  });
}

async function runTool(name, args, emit, signal) {
  try {
    args = args && typeof args === "object" ? args : {};
    if (name === "list_dir") {
      const dir = safeResolve(args.dir || ".");
      const items = fs.readdirSync(dir, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + "/" : d.name));
      return items.length ? items.join("\n") : "(empty)";
    }
    if (name === "read_file") {
      const f = safeResolve(args.file);
      const size = fs.statSync(f).size;
      if (size > 5 * 1024 * 1024) return `ERROR: file is too large to read (${Math.round(size / 1024 / 1024)} MB)`;
      const data = fs.readFileSync(f, "utf8");
      return data.length > 30000 ? data.slice(0, 30000) + "\n...[truncated]" : data;
    }
    if (name === "write_file") {
      const f = safeResolve(args.file);
      const content = typeof args.content === "string" ? args.content : "";
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = f + ".tmp-" + crypto.randomBytes(4).toString("hex");
      fs.writeFileSync(tmp, content, "utf8");   // write fully, then swap in: no half-written files
      fs.renameSync(tmp, f);
      return "Wrote " + args.file + " (" + content.length + " characters)";
    }
    if (name === "run_command") {
      const command = String(args.command || "").trim();
      if (!command) return "ERROR: empty command";
      const approved = await requestApproval(command, emit, signal);
      if (!approved) return "Command denied by user.";
      emit({ type: "command_running", command });
      return await execCommand(command);
    }
    return "Unknown tool: " + name;
  } catch (e) {
    return "ERROR: " + e.message;
  }
}

// ---------- Model call (OpenRouter-compatible) ----------
const MODEL_TIMEOUT_MS = 180000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

async function callModel(messages, { signal, emit = () => {}, retries = 3, fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal && signal.aborted) throw new Error("Stopped.");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MODEL_TIMEOUT_MS);
    const onAbort = () => ac.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    let res, text;
    try {
      res = await fetchImpl(BASE_URL + "/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + API_KEY, "Content-Type": "application/json",
                   "HTTP-Referer": "http://localhost:" + PORT, "X-Title": "AI Coding App" },
        body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: "auto" }),
        signal: ac.signal,
      });
      text = await res.text();
    } catch (e) {
      if (signal && signal.aborted) throw new Error("Stopped.");
      lastError = new Error(e.name === "AbortError" ? `Model request timed out after ${MODEL_TIMEOUT_MS / 1000}s` : "Network error calling model: " + e.message);
      res = null;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }

    if (res) {
      let data = null;
      try { data = JSON.parse(text); } catch {}
      // Free models rate-limit often; a short wait usually clears it.
      const retryable = RETRY_STATUS.has(res.status) || (data && data.error && RETRY_STATUS.has(Number(data.error.code)));
      if (!retryable) {
        if (!data) throw new Error(`Model returned non-JSON (HTTP ${res.status}): ` + text.slice(0, 300));
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        if (!res.ok) throw new Error(`Model HTTP ${res.status}: ` + text.slice(0, 300));
        if (!data.choices || !data.choices[0] || !data.choices[0].message) throw new Error("No response from model: " + text.slice(0, 300));
        return data.choices[0].message;
      }
      lastError = new Error((data && data.error && data.error.message) || `Model HTTP ${res.status}`);
    }
    if (attempt < retries) {
      const wait = Math.min(2000 * 2 ** attempt, 15000);
      emit({ type: "status", message: `The model is busy (${lastError.message.slice(0, 80)}). Trying again in ${Math.round(wait / 1000)}s…` });
      await sleep(wait, signal);
    }
  }
  throw lastError;
}

// Keep the conversation bounded without cutting a tool call from its result.
function trimHistory(list, max = MAX_HISTORY_MESSAGES) {
  if (list.length <= max) return list;
  let start = list.length - max;
  while (start < list.length && list[start].role !== "user") start++;
  return start < list.length ? list.slice(start) : list.slice(-1);
}

// ---------- Agent loop (OpenRouter engine) ----------
async function agentLoop(userMessage, emit, signal, deps = {}) {
  const call = deps.callModel || callModel;
  history.push({ role: "user", content: userMessage });
  history = trimHistory(history);
  const messages = [{ role: "system", content: SYSTEM_PROMPT + "\nWorking directory: " + workingDir }, ...history];

  for (let i = 0; i < MAX_STEPS; i++) {
    if (signal && signal.aborted) throw new Error("Stopped.");
    emit({ type: "thinking" });
    const msg = await call(messages, { signal, emit });
    messages.push(msg);
    history.push(msg);

    if (msg.tool_calls && msg.tool_calls.length) {
      if (msg.content) emit({ type: "assistant", content: msg.content });
      for (const tc of msg.tool_calls) {
        let args = {};
        let badArgs = false;
        try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch { badArgs = true; }
        const name = (tc.function && tc.function.name) || "unknown";
        emit({ type: "tool_call", name, args });
        // Tell the model its arguments were unreadable instead of running the tool with none.
        const result = badArgs ? "ERROR: the tool arguments were not valid JSON. Send them again." : await runTool(name, args, emit, signal);
        emit({ type: "tool_result", name, result });
        const toolMsg = { role: "tool", tool_call_id: tc.id, content: String(result) };
        messages.push(toolMsg);
        history.push(toolMsg);
      }
      continue;
    }

    const finalText = msg.content || "(done)";
    emit({ type: "assistant", content: finalText });
    return finalText;
  }
  const stopped = `Stopped after ${MAX_STEPS} steps to avoid a loop.`;
  emit({ type: "assistant", content: stopped });
  return stopped;
}

// The CLI engines start fresh each time, so earlier turns are handed over as text.
function withTranscript(message, turns = transcript, budget = 6000) {
  const lines = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const line = `${turns[i].role === "user" ? "User" : "Assistant"}: ${turns[i].text}`;
    if (used + line.length > budget) break;
    lines.unshift(line);
    used += line.length;
  }
  if (!lines.length) return message;
  return `Earlier in this conversation:\n${lines.join("\n")}\n\nCurrent request:\n${message}`;
}

// ---------- Server ----------
function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(localOnly);
  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(path.join(__dirname, "public")));

  let current = null; // { abort } while a task runs

  app.get("/api/state", (req, res) => {
    res.json({
      model: MODEL, baseUrl: BASE_URL, hasKey: !!API_KEY, cwd: workingDir, defaultCwd: DEFAULT_CWD, busy: !!current,
      engines: engines.listEngines({ hasApiKey: !!API_KEY, model: MODEL }),
      antigravity: engines.antigravityInstalled(),
    });
  });

  app.post("/api/setcwd", (req, res) => {
    if (current) return res.status(409).json({ error: "Wait for the running task to finish before changing folder." });
    const p = String((req.body && req.body.cwd) || "").trim();
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

  app.post("/api/reset", (req, res) => {
    if (current) return res.status(409).json({ error: "A task is running. Stop it first." });
    history = []; transcript = [];
    res.json({ ok: true });
  });

  app.post("/api/approve", (req, res) => {
    const { id, approved } = req.body || {};
    const settle = pendingApprovals.get(id);
    if (!settle) return res.status(404).json({ error: "No pending approval" });
    settle(approved === true);          // only an explicit true approves
    res.json({ ok: true });
  });

  app.post("/api/stop", (req, res) => {
    if (!current) return res.json({ ok: true, running: false });
    current.abort();
    res.json({ ok: true, running: true });
  });

  app.post("/api/open-antigravity", (req, res) => {
    try { res.json({ ok: true, folder: engines.openInAntigravity(workingDir) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post("/api/chat", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    const emit = (obj) => { try { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); } catch {} };
    if (current) {
      emit({ type: "error", message: "A task is already running. Wait for it to finish or press Stop." });
      return res.end();
    }
    const message = String((req.body && req.body.message) || "").trim();
    const engine = String((req.body && req.body.engine) || "openrouter");
    if (!message) { emit({ type: "error", message: "Type a request first." }); return res.end(); }
    if (!engines.ENGINES[engine]) { emit({ type: "error", message: "Unknown engine: " + engine }); return res.end(); }

    const ac = new AbortController();
    current = { abort: () => ac.abort() };
    // A closed tab can no longer approve or read anything: stop the task.
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });

    try {
      let finalText;
      if (engine === "openrouter") {
        if (!API_KEY) throw new Error("No API key found. Put OPENROUTER_API_KEY=... in a .env file next to server.js, or pick another engine.");
        finalText = await agentLoop(message, emit, ac.signal);
      } else {
        emit({ type: "thinking" });
        finalText = await engines.runCliEngine(engine, withTranscript(message), workingDir, emit, ac.signal);
      }
      transcript.push({ role: "user", text: message }, { role: "assistant", text: String(finalText || "").slice(0, 2000) });
      transcript = transcript.slice(-20);
      emit({ type: "done" });
    } catch (e) {
      emit({ type: ac.signal.aborted ? "stopped" : "error", message: ac.signal.aborted ? "Stopped." : e.message });
    } finally {
      current = null;
      res.end();
    }
  });

  return app;
}

if (require.main === module) {
  // 127.0.0.1 only: without a host, Express listens on every network interface
  // and anyone on the same Wi-Fi could reach an agent that runs commands.
  createApp().listen(PORT, "127.0.0.1", () => {
    console.log("\n  AI Coding App running:  http://localhost:" + PORT);
    console.log("  Working dir:", workingDir);
    for (const e of engines.listEngines({ hasApiKey: !!API_KEY, model: MODEL })) {
      console.log(`  ${e.ready ? "ready " : "absent"}  ${e.label}  (${e.detail})`);
    }
    console.log("");
  });
}

module.exports = {
  createApp, parseEnv, safeResolve, runTool, execCommand, callModel, agentLoop, trimHistory, withTranscript,
  _state: { reset() { history = []; transcript = []; }, setCwd(d) { workingDir = d; }, getCwd: () => workingDir, getHistory: () => history },
};
