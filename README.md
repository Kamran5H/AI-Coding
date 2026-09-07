# AI Coding App ⚡

> **A local AI coding agent with an interactive Web GUI — free, runs directly on your machine.**

Designed for developer autonomy: type your request in the intuitive web interface, and the agent inspects, reads, creates, and modifies files, and executes shell commands — with strict human-in-the-loop approval before any command execution.

---

## ✨ Features

- 🖥️ **Interactive Web GUI**: Clean, dark-mode web console running locally on http://localhost:8787.
- 🛡️ **Human-in-the-Loop Safety**: The agent pauses and requests explicit approval before running any system commands.
- 📁 **Workspace Scoped**: Safe execution sandboxed within your chosen workspace directory.
- 📊 **Tool Visualizer**: Expandable cards for file inspection (📄 read), file creation & edits (✏️ write), and shell executions (⚡ run).
- 🧠 **Free Model Tier**: Seamlessly integrates with OpenRouter free-tier LLMs (MiniMax, GLM, etc.) with zero setup friction.
- 💻 **Terminal CLI Mode**: Includes optional terminal runner for quick headless sessions.

---

## 🚀 Getting Started

### 1. Launch the Web GUI
Double-click start-app.cmd or run:
\\\ash
npm install
node server.js
\\\
The server starts at http://localhost:8787 and automatically opens your browser.

### 2. Launch the Terminal CLI
Prefer working directly in the shell? Run:
\\\ash
start-agent.cmd
\\\

---

## 🛠️ Project Structure

\\\
├── server.js          # Express server & AI agent orchestration backend
├── public/            # Modern frontend UI (HTML5, CSS3, Vanilla JS)
│   ├── index.html     # Dashboard layout
│   ├── style.css      # Dark aesthetic interface styles
│   └── app.js         # Streaming client & tool interactions
├── start-app.cmd      # One-click Windows GUI launcher
├── start-agent.cmd    # Terminal agent launcher
├── package.json       # Dependencies
└── HOW-TO-USE.md      # User guide
\\\

---

## 👤 Author

**Kamran Ashraf**  
- GitHub: [@Kamran5H](https://github.com/Kamran5H)
