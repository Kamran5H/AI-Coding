// Stand-in for `claude -p --output-format stream-json`: echoes the task and writes a file.
const fs = require("fs");
let input = "";
process.stdin.on("data", (c) => (input += c)).on("end", () => {
  if (input.includes("FAIL")) { process.stderr.write("Invalid API key · Please run /login\n"); process.exit(1); }
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  out({ type: "system", subtype: "init", cwd: process.cwd() });
  out({ type: "assistant", message: { content: [{ type: "text", text: "I'll create the file." }, { type: "tool_use", name: "Write", input: { file_path: "made-by-claude.txt" } }] } });
  fs.writeFileSync("made-by-claude.txt", "hello");
  out({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "File created" }] }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Done. Task was: " + input.slice(-40) }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "Done." });
  if (input.includes("HANG")) setInterval(() => {}, 1000);
});
