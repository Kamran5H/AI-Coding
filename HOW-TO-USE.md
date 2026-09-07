# AI Coding App — How To Use

A beautiful local AI coding agent with a GUI. Free, on your machine.
You type in the app, it reads/edits files and runs commands — asking approval first, like Claude Code.

## Start the app (GUI)
Double-click **start-app.cmd**.
- First run installs dependencies automatically (one-time, ~15 sec).
- A black window opens (the server — keep it open) and your browser opens the app.
- Address: http://localhost:8787

To stop: close the black server window.

## Using it
- Type a request and press Enter (Shift+Enter for a new line).
- The agent works in the **workspace** folder by default. Put files you want it to
  touch in there, or change the working folder using the box at the top right ("Set").
- When it wants to **run a command**, it pauses and asks — click **Approve & run** or **Deny**.
- Click any tool card (📄 read, ✏️ write, ⚡ run) to expand and see details.
- "＋ New chat" clears the conversation.

## What it can do
- Read and edit any file inside the working folder
- Create new files and folders
- Run shell commands (with your approval)
- Everything is scoped to the working folder for safety.

## Model & cost
- Model: MiniMax M3 (free) via OpenRouter — set in %USERPROFILE%\.qwen\.env
- Cost: $0. Free-tier limits: 200 requests/day, 20/minute.
- If you see a rate-limit error, wait a few seconds or switch models in the .env
  (flip which OPENAI_MODEL line is commented; z-ai/glm-5.2:free is the stronger coder).

## Terminal version (optional)
Prefer the terminal? Double-click **start-agent.cmd** to run the Qwen Code CLI instead.

## Files in this folder
- start-app.cmd    -> launches the GUI app (recommended)
- start-agent.cmd  -> launches the terminal CLI version
- server.js        -> the app's backend (agent brain)
- public/          -> the app's UI
- workspace/       -> default folder the agent works in
