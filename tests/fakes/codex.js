// Stand-in for `codex exec --json`.
let input = "";
process.stdin.on("data", (c) => (input += c)).on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  out({ type: "thread.started", thread_id: "t1" });
  out({ type: "item.started", item: { id: "1", type: "command_execution", command: "ls" } });
  out({ type: "item.completed", item: { id: "1", type: "command_execution", command: "ls", aggregated_output: "a.txt\n", exit_code: 0 } });
  out({ type: "item.completed", item: { id: "2", type: "file_change", changes: [{ path: "a.txt", kind: "update" }] } });
  out({ type: "item.completed", item: { id: "3", type: "agent_message", text: "Updated a.txt" } });
  out({ type: "turn.completed", usage: {} });
});
