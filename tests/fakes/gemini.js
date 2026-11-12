// Stand-in for `gemini --output-format stream-json`.
let input = "";
process.stdin.on("data", (c) => (input += c)).on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  process.stdout.write("Loaded cached credentials.\n");            // a non-JSON banner line
  out({ type: "init", session_id: "s1" });
  out({ type: "message", role: "user", content: input });
  out({ type: "message", role: "assistant", content: "Reading ", delta: true });
  out({ type: "message", role: "assistant", content: "the folder.", delta: true });
  out({ type: "tool_use", tool_name: "list_directory", parameters: { path: "." } });
  out({ type: "tool_result", status: "success", output: "a.txt" });
  out({ type: "message", role: "assistant", content: "There is one file.", delta: true });
  out({ type: "result", status: "success" });
});
