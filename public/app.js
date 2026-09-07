const $ = (s) => document.querySelector(s);
const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#sendBtn");
let busy = false;

// Markdown setup
if (window.marked) {
  marked.setOptions({
    highlight: (code, lang) => {
      if (window.hljs && lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; } catch {}
      }
      return window.hljs ? hljs.highlightAuto(code).value : code;
    },
    breaks: true,
  });
}
function md(text) {
  if (window.marked) return marked.parse(text || "");
  const esc = (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return "<p>" + esc.replace(/\n/g, "<br>") + "</p>";
}
function escapeHtml(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function clearWelcome() { const w = messagesEl.querySelector(".welcome"); if (w) w.remove(); }
function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function addUser(text) {
  clearWelcome();
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="bubble"></div>`;
  el.querySelector(".bubble").textContent = text;
  messagesEl.appendChild(el);
  scrollDown();
}

function addAssistant(html) {
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="row"><div class="avatar">◆</div><div class="bubble">${html}</div></div>`;
  messagesEl.appendChild(el);
  if (window.hljs) el.querySelectorAll("pre code").forEach((b) => hljs.highlightElement(b));
  scrollDown();
}

const toolIcons = { list_dir: "📂", read_file: "📄", write_file: "✏️", run_command: "⚡" };
function addToolCard(name, args) {
  const target = args.file || args.dir || args.command || "";
  const el = document.createElement("div");
  el.className = "tool";
  el.innerHTML = `
    <div class="tool-head">
      <div class="tool-ico">${toolIcons[name] || "🔧"}</div>
      <span class="tool-name">${name.replace("_", " ")}</span>
      <span class="tool-target">${escapeHtml(String(target).slice(0, 80))}</span>
      <span class="tool-chevron">▶</span>
    </div>
    <div class="tool-body"><pre></pre></div>`;
  el.querySelector(".tool-head").onclick = () => el.classList.toggle("open");
  if (args.content !== undefined) el.querySelector("pre").textContent = args.content;
  messagesEl.appendChild(el);
  scrollDown();
  return el;
}
function fillToolResult(card, result) {
  if (!card) return;
  const pre = card.querySelector("pre");
  const existing = pre.textContent;
  pre.textContent = existing ? existing + "\n\n── result ──\n" + result : result;
}

function addApproval(id, command) {
  const el = document.createElement("div");
  el.className = "approval";
  el.innerHTML = `
    <div class="approval-title">⚡ Run this command?</div>
    <pre>${escapeHtml(command)}</pre>
    <div class="approval-btns">
      <button class="btn-approve">Approve &amp; run</button>
      <button class="btn-deny">Deny</button>
    </div>
    <div class="approval-verdict" style="display:none"></div>`;
  const finish = (approved) => {
    el.classList.add("resolved");
    const v = el.querySelector(".approval-verdict");
    v.style.display = "block";
    v.textContent = approved ? "✓ Approved" : "✕ Denied";
    v.style.color = approved ? "var(--green)" : "var(--red)";
    fetch("/api/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, approved }) });
  };
  el.querySelector(".btn-approve").onclick = () => finish(true);
  el.querySelector(".btn-deny").onclick = () => finish(false);
  messagesEl.appendChild(el);
  scrollDown();
}

let thinkingEl = null;
function showThinking() {
  hideThinking();
  thinkingEl = document.createElement("div");
  thinkingEl.className = "thinking";
  thinkingEl.innerHTML = `<div class="avatar">◆</div><span>Working</span><span class="dots"><span></span><span></span><span></span></span>`;
  messagesEl.appendChild(thinkingEl);
  scrollDown();
}
function hideThinking() { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } }

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true; sendBtn.disabled = true;
  addUser(text);
  inputEl.value = ""; autosize();

  const toolCards = {};
  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        handleEvent(ev, toolCards);
      }
    }
  } catch (e) {
    hideThinking();
    addAssistant(`<p style="color:var(--red)">Connection error: ${escapeHtml(e.message)}</p>`);
  }
  busy = false; sendBtn.disabled = false;
  inputEl.focus();
}

function handleEvent(ev, toolCards) {
  switch (ev.type) {
    case "thinking": showThinking(); break;
    case "assistant": hideThinking(); if (ev.content && ev.content.trim()) addAssistant(md(ev.content)); break;
    case "tool_call": {
      hideThinking();
      const card = addToolCard(ev.name, ev.args || {});
      toolCards[ev.name + ":" + JSON.stringify(ev.args)] = card;
      toolCards.__last = card;
      break;
    }
    case "tool_result": fillToolResult(toolCards.__last, ev.result); break;
    case "approval": hideThinking(); addApproval(ev.id, ev.command); break;
    case "command_running": break;
    case "done": hideThinking(); break;
    case "error": hideThinking(); addAssistant(`<p style="color:var(--red)">⚠ ${escapeHtml(ev.message)}</p>`); break;
  }
}

// Input handling
function autosize() { inputEl.style.height = "auto"; inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px"; }
inputEl.addEventListener("input", autosize);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(inputEl.value); }
});
sendBtn.onclick = () => send(inputEl.value);
document.querySelectorAll(".chip").forEach((c) => c.onclick = () => send(c.dataset.prompt));

// New chat
$("#newChatBtn").onclick = async () => {
  await fetch("/api/reset", { method: "POST" });
  messagesEl.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">◆</div>
      <h1>What are we building?</h1>
      <p>I can read and edit files, run commands, and work through tasks in your folder — free, on your machine.</p>
    </div>`;
};

// Working folder
$("#cwdBtn").onclick = async () => {
  const cwd = $("#cwdInput").value.trim();
  const res = await fetch("/api/setcwd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }) });
  const data = await res.json();
  if (data.error) { $("#statusHint").textContent = "⚠ " + data.error; }
  else { $("#cwdInput").value = data.cwd; $("#statusHint").textContent = "Working folder set ✓"; }
};

// Init
fetch("/api/state").then((r) => r.json()).then((s) => {
  $("#modelBadge").textContent = s.model + (s.hasKey ? "" : "  ·  NO KEY");
  $("#cwdInput").value = s.cwd;
}).catch(() => { $("#modelBadge").textContent = "server offline"; });
