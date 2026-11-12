const $ = (s) => document.querySelector(s);
const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#sendBtn");
const stopBtn = $("#stopBtn");
const engineSelect = $("#engineSelect");
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
// Model output is untrusted: it can repeat text from any file it read. Rendered
// as raw HTML, a planted <script> or onerror= could click "Approve & run" for
// the user. Everything is rebuilt through a strict allow-list before display.
const ALLOWED_TAGS = new Set(["P", "BR", "HR", "STRONG", "B", "EM", "I", "DEL", "S", "CODE", "PRE", "BLOCKQUOTE", "UL", "OL", "LI",
  "H1", "H2", "H3", "H4", "H5", "H6", "A", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "SPAN", "DIV"]);
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString("<body>" + html + "</body>", "text/html");
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE || !ALLOWED_TAGS.has(child.tagName)) {
        // Unknown element: keep its text, drop the element (and scripts entirely).
        const keep = child.nodeType === Node.ELEMENT_NODE && !["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE"].includes(child.tagName);
        child.replaceWith(document.createTextNode(keep ? child.textContent : ""));
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        const safeHref = name === "href" && child.tagName === "A" && /^(https?:|mailto:)/i.test(attr.value.trim());
        const safeClass = name === "class" && /^[\w\- ]*$/.test(attr.value);
        if (!safeHref && !safeClass) child.removeAttribute(attr.name);
      }
      if (child.tagName === "A") { child.setAttribute("target", "_blank"); child.setAttribute("rel", "noopener noreferrer"); }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}
function md(text) {
  if (window.marked) return sanitizeHtml(marked.parse(text || ""));
  return "<p>" + escapeHtml(text || "").replace(/\n/g, "<br>") + "</p>";
}
function escapeHtml(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
const postJson = (url, body = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

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
      <span class="tool-name">${escapeHtml(String(name).replace(/_/g, " "))}</span>
      <span class="tool-target">${escapeHtml(String(target).slice(0, 80))}</span>
      <span class="tool-chevron">▶</span>
    </div>
    <div class="tool-body"><pre></pre></div>`;
  el.querySelector(".tool-head").onclick = () => el.classList.toggle("open");
  if (typeof args.content === "string") el.querySelector("pre").textContent = args.content;
  else if (!target && Object.keys(args).length) el.querySelector("pre").textContent = JSON.stringify(args, null, 2);
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
    postJson("/api/approve", { id, approved });
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
  busy = true; sendBtn.disabled = true; stopBtn.hidden = false;
  addUser(text);
  inputEl.value = ""; autosize();

  const toolCards = {};
  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, engine: engineSelect.value || "openrouter" }),
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
  hideThinking();
  // A task that ended (or was stopped) can no longer use an open approval card.
  document.querySelectorAll(".approval:not(.resolved)").forEach((el) => {
    el.classList.add("resolved");
    const v = el.querySelector(".approval-verdict");
    v.style.display = "block"; v.textContent = "✕ Not run (task ended)"; v.style.color = "var(--red)";
  });
  busy = false; sendBtn.disabled = false; stopBtn.hidden = true;
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
    case "status": $("#statusHint").textContent = ev.message; break;
    case "stopped": hideThinking(); addAssistant(`<p style="color:var(--muted, #9aa4b2)">■ Stopped.</p>`); break;
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
  const r = await postJson("/api/reset");
  if (!r.ok) { $("#statusHint").textContent = "⚠ " + ((await r.json()).error || "Could not start a new chat"); return; }
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
  const res = await postJson("/api/setcwd", { cwd });
  const data = await res.json();
  if (data.error) { $("#statusHint").textContent = "⚠ " + data.error; }
  else { $("#cwdInput").value = data.cwd; $("#statusHint").textContent = "Working folder set ✓"; }
};

// Stop
stopBtn.onclick = () => postJson("/api/stop");

// Engines
function describeEngine() {
  const e = (window.__engines || []).find((x) => x.id === engineSelect.value);
  if (!e) return;
  $("#modelBadge").textContent = e.ready ? `${e.label} · ${e.detail}` : `${e.label} · ${e.detail}`;
  $("#statusHint").textContent = e.ready ? "Enter to send · Shift+Enter for newline" : (e.install ? "To use this engine: " + e.install : "Add an API key to use this engine.");
}
engineSelect.onchange = () => { try { localStorage.setItem("engine", engineSelect.value); } catch {} describeEngine(); };
$("#antigravityBtn").onclick = async () => {
  const r = await postJson("/api/open-antigravity");
  const d = await r.json();
  $("#statusHint").textContent = d.error ? "⚠ " + d.error : "Opened in Antigravity ✓";
};

// Init
fetch("/api/state").then((r) => r.json()).then((s) => {
  $("#cwdInput").value = s.cwd;
  window.__engines = s.engines || [];
  engineSelect.innerHTML = "";
  for (const e of window.__engines) {
    const o = document.createElement("option");
    o.value = e.id; o.textContent = (e.ready ? "● " : "○ ") + e.label;
    engineSelect.appendChild(o);
  }
  let saved = null; try { saved = localStorage.getItem("engine"); } catch {}
  const ready = window.__engines.filter((e) => e.ready).map((e) => e.id);
  engineSelect.value = ready.includes(saved) ? saved : (ready[0] || "openrouter");
  describeEngine();
}).catch(() => { $("#modelBadge").textContent = "server offline"; });
