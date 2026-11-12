const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const fakes = path.join(__dirname, "fakes");
process.env.CLAUDE_CLI = path.join(fakes, "claude.js");
process.env.CODEX_CLI = path.join(fakes, "codex.js");
process.env.GEMINI_CLI = path.join(fakes, "gemini.js");
process.env.ANTIGRAVITY_CLI = path.join(fakes, "missing-antigravity.js");

const server = require("../server");
const engines = require("../lib/engines");
const { isLocalRequest } = require("../lib/guard");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aicoding-"));

function request(port, { method = "GET", url = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c)).on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const json = (port, url, payload, extra = {}) => request(port, {
  method: "POST", url, headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(payload),
});
const events = (body) => body.split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function withServer(fn) {
  const srv = server.createApp().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  try { await fn(srv.address().port); } finally { await new Promise((r) => srv.close(r)); }
}

// ── local-only guard ─────────────────────────────────────────────────────────

test("only this computer's browser may talk to the server", () => {
  assert.equal(isLocalRequest({ host: "localhost:8787" }), true);
  assert.equal(isLocalRequest({ host: "127.0.0.1:8787", origin: "http://localhost:8787" }), true);
  assert.equal(isLocalRequest({ host: "[::1]:8787" }), true);
  assert.equal(isLocalRequest({ host: "192.168.1.20:8787" }), false);              // another device on the Wi-Fi
  assert.equal(isLocalRequest({ host: "evil.example:8787" }), false);              // DNS rebinding
  assert.equal(isLocalRequest({ host: "localhost:8787", origin: "https://evil.example" }), false);
  assert.equal(isLocalRequest({ host: "localhost:8787", secFetchSite: "cross-site" }), false);
});

test("foreign hosts, cross-site pages and form posts are refused over HTTP", async () => {
  await withServer(async (port) => {
    assert.equal((await request(port, { url: "/api/state", headers: { Host: "evil.example" } })).status, 403);
    assert.equal((await json(port, "/api/reset", {}, { Origin: "https://evil.example" })).status, 403);
    const form = await request(port, { method: "POST", url: "/api/reset", headers: { "Content-Type": "text/plain" }, body: "x" });
    assert.equal(form.status, 415);
    const ok = await request(port, { url: "/api/state" });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["x-frame-options"], "DENY");
  });
});

// ── sandbox ──────────────────────────────────────────────────────────────────

test("paths outside the working folder are refused, including through links", () => {
  const root = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");
  assert.equal(server.safeResolve("a/b.txt", root), path.join(root, "a", "b.txt"));
  assert.throws(() => server.safeResolve("../x", root), /outside/);
  assert.throws(() => server.safeResolve(path.join(outside, "secret.txt"), root), /outside/);
  assert.throws(() => server.safeResolve(root + "-sibling/x", root), /outside/);
  try { fs.symlinkSync(outside, path.join(root, "link"), "junction"); } catch { return; }   // links not permitted here
  assert.throws(() => server.safeResolve("link/secret.txt", root), /through a link/);
  assert.throws(() => server.safeResolve("link/new/file.txt", root), /through a link/);
});

test("file tools work inside the folder and writes replace files whole", async () => {
  const root = tmp();
  server._state.setCwd(root);
  assert.match(await server.runTool("write_file", { file: "src/a.txt", content: "one" }, () => {}), /Wrote src\/a.txt/);
  await server.runTool("write_file", { file: "src/a.txt", content: "two" }, () => {});
  assert.equal(await server.runTool("read_file", { file: "src/a.txt" }, () => {}), "two");
  assert.deepEqual(fs.readdirSync(path.join(root, "src")), ["a.txt"]);              // no temp files left
  assert.equal(await server.runTool("list_dir", { dir: "." }, () => {}), "src/");
  assert.match(await server.runTool("read_file", { file: "../../etc/passwd" }, () => {}), /^ERROR: Path is outside/);
  assert.match(await server.runTool("nope", {}, () => {}), /Unknown tool/);
});

test("a command runs only after an explicit yes, and a vanished browser means no", async () => {
  const root = tmp();
  server._state.setCwd(root);
  const ac = new AbortController();
  const seen = [];
  const pending = server.runTool("run_command", { command: "node -e \"console.log(40+2)\"" }, (e) => seen.push(e), ac.signal);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen[0].type, "approval");
  ac.abort();                                                                      // tab closed / Stop pressed
  assert.equal(await pending, "Command denied by user.");
  assert.equal(seen.some((e) => e.type === "command_running"), false);
});

// ── OpenRouter engine ────────────────────────────────────────────────────────

const reply = (status, payload) => ({ status, ok: status < 400, text: async () => JSON.stringify(payload) });

test("a rate-limited model call is retried, then succeeds", async () => {
  let calls = 0;
  const notes = [];
  const fetchImpl = async () => (++calls < 2 ? reply(429, { error: { message: "rate limited", code: 429 } })
                                             : reply(200, { choices: [{ message: { role: "assistant", content: "hi" } }] }));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 5);                                                  // skip the real back-off wait
  const first = server.callModel([], { fetchImpl, emit: (e) => notes.push(e), retries: 0 }).catch((e) => e);
  assert.match((await first).message, /rate limited/);
  calls = 0;
  const real = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => real(fn, Math.min(ms, 5), ...a);
  try {
    const msg = await server.callModel([], { fetchImpl, emit: (e) => notes.push(e) });
    assert.equal(msg.content, "hi");
  } finally { global.setTimeout = real; }
  assert.equal(calls, 2);
  assert.ok(notes.some((e) => e.type === "status" && /busy/.test(e.message)));
});

test("a real model error is reported once, not retried", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply(401, { error: { message: "No auth credentials found" } }); };
  await assert.rejects(server.callModel([], { fetchImpl }), /No auth credentials/);
  assert.equal(calls, 1);
});

test("the agent loop runs tools, survives unreadable arguments and answers", async () => {
  const root = tmp();
  server._state.setCwd(root);
  server._state.reset();
  const script = [
    { role: "assistant", content: "", tool_calls: [{ id: "1", function: { name: "write_file", arguments: "{not json" } }] },
    { role: "assistant", content: "", tool_calls: [{ id: "2", function: { name: "write_file", arguments: JSON.stringify({ file: "x.txt", content: "ok" }) } }] },
    { role: "assistant", content: "Created x.txt" },
  ];
  const seen = [];
  const sent = [];
  const final = await server.agentLoop("make x", (e) => seen.push(e), undefined, {
    callModel: async (messages) => { sent.push(messages.length); return script.shift(); },
  });
  assert.equal(final, "Created x.txt");
  assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "ok");
  assert.match(seen.find((e) => e.type === "tool_result").result, /not valid JSON/);
  assert.equal(seen.filter((e) => e.type === "tool_call").length, 2);
});

test("history is trimmed at a user turn so tool results keep their calls", () => {
  const list = [];
  for (let i = 0; i < 30; i++) list.push({ role: "user", content: "q" + i }, { role: "assistant", tool_calls: [{}] }, { role: "tool", content: "r" });
  const cut = server.trimHistory(list, 10);
  assert.ok(cut.length <= 10 && cut[0].role === "user");
  assert.equal(server.trimHistory(list.slice(0, 6), 10).length, 6);
});

test(".env parsing: comments, quotes, first value wins", () => {
  assert.deepEqual(server.parseEnv('# c\nA=1\nB="two words"\n A = 9 \nC=\'x\'\n'), { A: "1", B: "two words", C: "x" });
});

// ── CLI engines (Claude / ChatGPT / Gemini) ──────────────────────────────────

test("each tool's event stream becomes chat bubbles and tool cards", () => {
  const c = engines.PARSERS.claude({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Edit", input: { file_path: "a" } }] } });
  assert.deepEqual(c.map((e) => e.type), ["assistant", "tool_call"]);
  assert.match(engines.PARSERS.claude({ type: "result", is_error: true, result: "Credit balance is too low" })[0].message, /Credit/);
  assert.equal(engines.PARSERS.chatgpt({ type: "item.completed", item: { type: "agent_message", text: "ok" } })[0].content, "ok");
  assert.equal(engines.PARSERS.chatgpt({ type: "turn.failed", error: { message: "usage limit" } })[0].type, "error");
  assert.equal(engines.PARSERS.chatgpt({ type: "error", message: "Reconnecting... 2/5 (stream disconnected)" })[0].type, "status");
  const state = {};
  assert.deepEqual(engines.PARSERS.gemini({ type: "message", role: "assistant", content: "a", delta: true }, state), []);
  assert.equal(engines.PARSERS.gemini({ type: "tool_use", tool_name: "ls", parameters: {} }, state)[0].content, "a");
  assert.deepEqual(engines.PARSERS.gemini({ type: "something_new" }, state), []);   // unknown events are ignored
});

test("Claude engine: runs in the folder, task goes in on stdin, events stream out", async () => {
  const root = tmp();
  const seen = [];
  const final = await engines.runCliEngine("claude", "create a file; echo `rm -rf` \"quoted\" $(x)", root, (e) => seen.push(e));
  assert.match(final, /Done\. Task was:.*\$\(x\)/);                                 // shell characters arrived as plain text
  assert.equal(fs.readFileSync(path.join(root, "made-by-claude.txt"), "utf8"), "hello");
  assert.deepEqual(seen.map((e) => e.type), ["assistant", "tool_call", "tool_result", "assistant"]);
});

test("ChatGPT and Gemini engines stream their events", async () => {
  const a = [];
  assert.equal(await engines.runCliEngine("chatgpt", "task", tmp(), (e) => a.push(e)), "Updated a.txt");
  assert.deepEqual(a.map((e) => e.type), ["tool_call", "tool_result", "tool_call", "assistant"]);
  const b = [];
  assert.equal(await engines.runCliEngine("gemini", "task", tmp(), (e) => b.push(e)), "There is one file.");
  assert.deepEqual(b.map((e) => e.type), ["assistant", "assistant", "tool_call", "tool_result", "assistant"]);
  assert.equal(b[0].content, "Loaded cached credentials.");
  assert.equal(b[1].content, "Reading the folder.");                                // deltas joined into one bubble
});

test("a tool that is not signed in gives a plain next step", async () => {
  await assert.rejects(engines.runCliEngine("claude", "FAIL please", tmp(), () => {}), /Please run \/login.*run `claude` once/s);
});

test("Stop ends a running CLI task", async () => {
  const ac = new AbortController();
  const run = engines.runCliEngine("claude", "HANG", tmp(), () => {}, ac.signal);
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(run, /Stopped/);
});

test("engine list reports what is installed and how to add the rest", () => {
  const list = engines.listEngines({ hasApiKey: false, model: "m" });
  assert.deepEqual(list.map((e) => e.id), ["openrouter", "claude", "chatgpt", "gemini"]);
  assert.equal(list[0].ready, false);
  assert.ok(list.slice(1).every((e) => e.ready));
  const saved = process.env.CODEX_CLI;
  process.env.CODEX_CLI = path.join(fakes, "nope.js");
  try {
    const codex = engines.listEngines({ hasApiKey: true, model: "m" }).find((e) => e.id === "chatgpt");
    assert.equal(codex.ready, false);
    assert.match(codex.install, /@openai\/codex/);
  } finally { process.env.CODEX_CLI = saved; }
});

// ── HTTP end to end ──────────────────────────────────────────────────────────

test("chat over HTTP with the Claude engine, follow-up carries the conversation", async () => {
  const root = tmp();
  await withServer(async (port) => {
    assert.equal((await json(port, "/api/setcwd", { cwd: root })).status, 200);
    await json(port, "/api/reset", {});
    const first = events((await json(port, "/api/chat", { message: "make the file", engine: "claude" })).body);
    assert.deepEqual(first.map((e) => e.type), ["thinking", "assistant", "tool_call", "tool_result", "assistant", "done"]);
    assert.ok(fs.existsSync(path.join(root, "made-by-claude.txt")));
    assert.match(server.withTranscript("and now?"), /Earlier in this conversation:\nUser: make the file\nAssistant: Done\./);
    const state = JSON.parse((await request(port, { url: "/api/state" })).body);
    assert.equal(state.busy, false);
    assert.equal(state.antigravity, false);
    assert.equal((await json(port, "/api/open-antigravity", {})).status, 400);
  });
});

test("bad chat requests get a clear message; a second task is refused while one runs", async () => {
  await withServer(async (port) => {
    assert.match(events((await json(port, "/api/chat", { message: "  " })).body)[0].message, /Type a request/);
    assert.match(events((await json(port, "/api/chat", { message: "x", engine: "skynet" })).body)[0].message, /Unknown engine/);
    assert.match(events((await json(port, "/api/chat", { message: "x", engine: "openrouter" })).body)[0].message, /No API key|Network|model|HTTP/i);
    const slow = json(port, "/api/chat", { message: "HANG", engine: "claude" });
    await new Promise((r) => setTimeout(r, 400));
    assert.match(events((await json(port, "/api/chat", { message: "x", engine: "claude" })).body)[0].message, /already running/);
    assert.equal((await json(port, "/api/reset", {})).status, 409);
    assert.equal(JSON.parse((await json(port, "/api/stop", {})).body).running, true);
    assert.equal(events((await slow).body).at(-1).type, "stopped");
    assert.equal((await json(port, "/api/approve", { id: "nope", approved: true })).status, 404);
  });
});
