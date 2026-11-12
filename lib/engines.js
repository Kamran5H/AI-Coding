// Engines: where the "brain" of a task comes from.
//
//   openrouter  the built-in agent loop in server.js (needs an API key; free models exist)
//   claude      Claude Code CLI   -> uses your Claude subscription login
//   chatgpt     OpenAI Codex CLI  -> uses your ChatGPT plan login
//   gemini      Gemini CLI        -> uses your Google account (the one Antigravity uses)
//
// The three CLI engines are the vendors' own official tools. This app starts
// them in the working folder, hands them the task on stdin and shows their
// streamed events. No password, cookie or token ever passes through this app:
// each tool keeps its own sign-in. Each is started in its "edit files, but do
// not run commands unasked" mode.
const { spawn, spawnSync } = require("child_process");
const path = require("path");

const ENGINES = {
  openrouter: { label: "OpenRouter (API key)", kind: "api" },
  claude: {
    label: "Claude (your Claude plan)", kind: "cli", env: "CLAUDE_CLI", bin: "claude",
    args: ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"],
    install: "npm install -g @anthropic-ai/claude-code   then run `claude` once to sign in",
  },
  chatgpt: {
    label: "ChatGPT (your ChatGPT plan)", kind: "cli", env: "CODEX_CLI", bin: "codex",
    args: ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-"],
    install: "npm install -g @openai/codex   then run `codex` once and choose Sign in with ChatGPT",
  },
  gemini: {
    label: "Gemini (your Google account)", kind: "cli", env: "GEMINI_CLI", bin: "gemini",
    args: ["--output-format", "stream-json", "--approval-mode", "auto_edit", "--skip-trust"],
    install: "npm install -g @google/gemini-cli   then run `gemini` once to sign in with Google",
  },
};

// A command override may be "node-script.js" (used by the tests) or a plain executable.
function resolveCommand(spec) {
  const override = (process.env[spec.env] || "").trim();
  const bin = override || spec.bin;
  if (/\.(c|m)?js$/i.test(bin)) return { command: process.execPath, prefix: [bin], shell: false };
  // Windows installs these tools as .cmd shims, which need the shell. Only
  // fixed arguments are ever passed; the task text travels on stdin.
  return { command: bin, prefix: [], shell: process.platform === "win32" };
}

const found = new Map(); // bin -> { at, ok }
function isInstalled(spec) {
  const { command, prefix } = resolveCommand(spec);
  if (prefix.length) return require("fs").existsSync(prefix[0]);
  const hit = found.get(command);
  if (hit && Date.now() - hit.at < 60000) return hit.ok;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore", windowsHide: true });
  const ok = probe.status === 0;
  found.set(command, { at: Date.now(), ok });
  return ok;
}

function listEngines({ hasApiKey, model }) {
  return Object.entries(ENGINES).map(([id, spec]) => {
    if (spec.kind === "api") {
      return { id, label: spec.label, ready: !!hasApiKey, detail: hasApiKey ? model : "no API key found", install: "" };
    }
    const ready = isInstalled(spec);
    return { id, label: spec.label, ready, detail: ready ? "installed" : "not installed", install: ready ? "" : spec.install };
  });
}

// ---------- Turning each tool's event stream into this app's events ----------
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : c.text || c.content || "")).join("");
  return content ? String(content.text || "") : "";
}
const clip = (s, n = 15000) => (s.length > n ? s.slice(0, n) + "\n...[truncated]" : s);

function claudeEvents(ev) {
  const out = [];
  if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
    for (const part of ev.message.content) {
      if (part.type === "text" && part.text) out.push({ type: "assistant", content: part.text });
      if (part.type === "tool_use") out.push({ type: "tool_call", name: part.name || "tool", args: part.input || {} });
    }
  } else if (ev.type === "user" && ev.message && Array.isArray(ev.message.content)) {
    for (const part of ev.message.content) {
      if (part.type === "tool_result") out.push({ type: "tool_result", name: "tool", result: clip(textOf(part.content)) });
    }
  } else if (ev.type === "result" && ev.is_error) {
    out.push({ type: "error", message: String(ev.result || ev.error || "Claude reported an error.") });
  }
  return out;
}

function codexEvents(ev) {
  const out = [];
  const item = ev.item || {};
  if (ev.type === "item.completed" && (item.type === "agent_message" || item.item_type === "assistant_message")) {
    if (item.text) out.push({ type: "assistant", content: item.text });
  } else if (ev.type === "item.started" && item.type === "command_execution") {
    out.push({ type: "tool_call", name: "run_command", args: { command: item.command || "" } });
  } else if (ev.type === "item.completed" && item.type === "command_execution") {
    out.push({ type: "tool_result", name: "run_command", result: clip(String(item.aggregated_output || item.output || "(no output)")) });
  } else if (ev.type === "item.completed" && item.type === "file_change") {
    const files = (item.changes || []).map((c) => `${c.kind || "edit"} ${c.path}`).join("\n");
    out.push({ type: "tool_call", name: "write_file", args: { file: files || "files", content: undefined } });
  } else if (ev.type === "error" || ev.type === "turn.failed") {
    const message = String(ev.message || (ev.error && ev.error.message) || "ChatGPT reported an error.");
    // Codex reports its own retries as errors; they are progress, not failure.
    out.push(/^Reconnecting/i.test(message) ? { type: "status", message: "ChatGPT: " + message.slice(0, 120) } : { type: "error", message });
  }
  return out;
}

function geminiEvents(ev, state) {
  const out = [];
  if (ev.type === "message" && ev.role === "assistant") {
    // Deltas arrive in small pieces; collect them and flush as one bubble.
    state.buffer = (state.buffer || "") + textOf(ev.content);
    if (!ev.delta) { out.push({ type: "assistant", content: state.buffer }); state.buffer = ""; }
  } else if (ev.type === "tool_use") {
    if (state.buffer) { out.push({ type: "assistant", content: state.buffer }); state.buffer = ""; }
    out.push({ type: "tool_call", name: ev.tool_name || ev.name || "tool", args: ev.parameters || ev.args || {} });
  } else if (ev.type === "tool_result") {
    out.push({ type: "tool_result", name: "tool", result: clip(textOf(ev.output || ev.result || ev.content) || String(ev.status || "")) });
  } else if (ev.type === "error" || (ev.type === "result" && ev.status === "error")) {
    out.push({ type: "error", message: String(ev.message || (ev.error && ev.error.message) || "Gemini reported an error.") });
  }
  return out;
}

const PARSERS = { claude: claudeEvents, chatgpt: codexEvents, gemini: geminiEvents };

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { child.kill("SIGTERM"); } catch {}
  }
}

const CLI_TIMEOUT_MS = 30 * 60 * 1000;

// Run one task through a CLI engine. Resolves with the final assistant text.
function runCliEngine(id, prompt, cwd, emit, signal) {
  const spec = ENGINES[id];
  return new Promise((resolve, reject) => {
    if (!spec || spec.kind !== "cli") return reject(new Error("Unknown engine: " + id));
    if (!isInstalled(spec)) return reject(new Error(`${spec.label} is not installed. To add it: ${spec.install}`));

    const { command, prefix, shell } = resolveCommand(spec);
    let child;
    try {
      child = spawn(command, [...prefix, ...spec.args], { cwd, shell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(new Error(`Could not start ${spec.label}: ${e.message}`));
    }

    const state = {};
    let pending = "";
    let stderr = "";
    let lastText = "";
    let sawOutput = false;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => { killTree(child); finish(reject, new Error(`${spec.label} did not finish within 30 minutes.`)); }, CLI_TIMEOUT_MS);
    if (signal) signal.addEventListener("abort", () => { killTree(child); finish(reject, new Error("Stopped.")); }, { once: true });

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      sawOutput = true;
      let ev;
      try { ev = JSON.parse(trimmed); } catch { ev = null; }
      // A line that is not JSON (a banner, a warning) is shown as plain text.
      const events = ev && typeof ev === "object" ? PARSERS[id](ev, state) : [{ type: "assistant", content: trimmed }];
      for (const e of events) {
        if (e.type === "assistant") lastText = e.content;
        emit(e);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(handleLine);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", (e) => finish(reject, new Error(`Could not start ${spec.label}: ${e.message}`)));
    child.on("close", (code) => {
      if (pending) handleLine(pending);
      if (state.buffer) { lastText = state.buffer; emit({ type: "assistant", content: state.buffer }); }
      if (code === 0 || (sawOutput && lastText)) return finish(resolve, lastText);
      const why = stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `exit code ${code}`;
      finish(reject, new Error(`${spec.label} stopped: ${why}. If you have not signed in yet, open a terminal and run \`${spec.bin}\` once.`));
    });

    child.stdin.on("error", () => {}); // the tool may exit before reading everything
    child.stdin.end(prompt);
  });
}

// ---------- Antigravity ----------
// Antigravity is an editor with no documented way for another program to hand
// it a task, so the honest integration is: open the working folder in it.
function antigravityCommand() {
  const override = (process.env.ANTIGRAVITY_CLI || "").trim();
  return override || "antigravity";
}
function antigravityInstalled() {
  return isInstalled({ env: "ANTIGRAVITY_CLI", bin: "antigravity" });
}
function openInAntigravity(folder) {
  if (!antigravityInstalled()) {
    throw new Error("Antigravity's `antigravity` command was not found. Install Antigravity, then use its Command Palette: “Shell Command: Install 'antigravity' command in PATH”.");
  }
  const { command, prefix, shell } = resolveCommand({ env: "ANTIGRAVITY_CLI", bin: "antigravity" });
  // The folder is a quoted single argument; with a shell on Windows, quotes are added explicitly.
  const arg = shell ? `"${String(folder).replace(/"/g, "")}"` : folder;
  const child = spawn(command, [...prefix, arg], { shell, windowsHide: true, detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return path.resolve(folder);
}

module.exports = { ENGINES, PARSERS, listEngines, runCliEngine, isInstalled, resolveCommand, openInAntigravity, antigravityInstalled, antigravityCommand };
