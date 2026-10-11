import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { grokStdioArgs } from "../server/args";
import { configFromOptions } from "../server/catalog";
import { readTextFile } from "../server/files";
import { permissionView } from "../server/permission";
import { promptText } from "../server/prompt-text";
import { listGrokSessions, readPersistence, sessionPersistence } from "../server/sessions";
import { replayLines } from "../server/transcript";

test("grok stdio args force a private agent", () => {
  assert.deepEqual(grokStdioArgs(["agent", "stdio"]), ["agent", "--no-leader", "stdio"]);
  assert.deepEqual(grokStdioArgs(["agent", "--no-leader", "stdio"]), ["agent", "--no-leader", "stdio"]);
  assert.deepEqual(grokStdioArgs([]), ["agent", "--no-leader", "stdio"]);
});

test("session list reads summaries, filters, and sorts", async () => {
  const home = await scratchDir("grok-sessions-");
  try {
    await writeSummary(home, "/work/a", "bbb", "Older", "2026-01-01T00:00:00.000Z", "first summary");
    await writeSummary(home, "/work/b", "aaa", "Newer title", "2026-02-01T00:00:00.000Z", "ship the widget");
    const broken = join(home, "sessions", "broken", "nope");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "summary.json"), "{", "utf8");
    const all = await listGrokSessions(home, {});
    assert.equal(all.length, 2);
    assert.equal(all[0]?.title, "Newer title");
    assert.equal(readPersistence(all[0]?.persistence.data)?.sessionId, "aaa");
    const filtered = await listGrokSessions(home, { cwd: "/work/a", query: "first" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.title, "Older");
    const missed = await listGrokSessions(home, { cwd: "/work/a", query: "widget" });
    assert.equal(missed.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("replay keeps user text, shell calls, and the tail", () => {
  const lines = [
    update("user_message_chunk", { content: { type: "text", text: "hello" }, _meta: { promptIndex: 0 } }),
    update("agent_message_chunk", { content: { type: "text", text: "hi" } }),
    update("tool_call", {
      toolCallId: "call-1",
      title: "run_terminal_command",
      rawInput: { command: "pwd" },
      _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" }, updateParams: { status: "Pending" } },
    }),
    update("tool_call_update", {
      toolCallId: "call-1",
      status: "completed",
      rawOutput: "done",
      _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } },
    }),
    update("user_message_chunk", { content: { type: "text", text: "again" }, _meta: { promptIndex: 1 } }),
  ];
  const items = replayLines(lines);
  assert.equal(items[0]?.type, "user_message");
  assert.equal(items[0]?.type === "user_message" ? items[0].text : "", "hello");
  assert.equal(items[1]?.type, "assistant_message");
  const tool = items.find((item) => item.type === "tool_call" && item.status === "completed");
  assert.ok(tool && tool.type === "tool_call");
  assert.equal(tool.detail.type, "shell");
  assert.equal(tool.detail.type === "shell" ? tool.detail.command : "", "pwd");
  const tail = replayLines(lines, 1);
  assert.equal(tail[0]?.type, "notification");
  assert.equal(tail.at(-1)?.type, "user_message");
});

test("permission selection follows the answer", () => {
  const view = permissionView(
    {
      toolCall: { toolCallId: "call-9", title: "bash" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
    "fallback",
  );
  assert.equal(view.request.id, "call-9");
  assert.deepEqual(view.outcomeFor({ behavior: "allow" }), { outcome: { outcome: "selected", optionId: "allow" } });
  assert.deepEqual(view.outcomeFor({ behavior: "deny", selectedActionId: "reject" }), {
    outcome: { outcome: "selected", optionId: "reject" },
  });
});

test("prompt text joins messages and renders commands", () => {
  assert.equal(
    promptText({
      clientMessageId: "m1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
    }),
    "one\n\ntwo",
  );
  assert.equal(
    promptText({ clientMessageId: "m2", delivery: "auto", input: { type: "command", name: "review", arguments: "now" } }),
    "/review now",
  );
});

test("readTextFile honors a line window", async () => {
  const dir = await scratchDir("grok-read-");
  const path = join(dir, "note.txt");
  try {
    await writeFile(path, "a\nb\nc\n", "utf8");
    assert.equal(await readTextFile(path, 2, 1), "b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live config options replace the static catalog", () => {
  const config = configFromOptions(
    [
      {
        id: "model",
        category: "model",
        currentValue: "grok-4.6",
        options: [{ value: "grok-4.6", name: "Grok 4.6" }],
      },
    ],
    undefined,
    "high",
  );
  assert.equal(config.model, "grok-4.6");
  assert.equal(config.models.length, 1);
  assert.equal(config.thinkingOption, "high");
});

test("persistence round trip", () => {
  const persistence = sessionPersistence("abc", "/work");
  assert.deepEqual(readPersistence(persistence.data), { sessionId: "abc", cwd: "/work" });
  assert.equal(readPersistence({ sessionId: "" }), null);
});

async function scratchDir(prefix: string): Promise<string> {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "../.scratch");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

async function writeSummary(
  home: string,
  cwd: string,
  id: string,
  title: string,
  updatedAt: string,
  summary: string,
): Promise<void> {
  const dir = join(home, "sessions", encodeURIComponent(cwd), id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "summary.json"),
    JSON.stringify({
      info: { id, cwd },
      generated_title: title,
      session_summary: summary,
      updated_at: updatedAt,
    }),
    "utf8",
  );
}

function update(sessionUpdate: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ method: "session/update", params: { update: { sessionUpdate, ...fields } } });
}
