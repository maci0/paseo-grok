import { createReadStream } from "node:fs";
import readline from "node:readline";
import type { ProviderTimelineItem, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { CONVERSATION_UPDATES, MAX_REPLAY_UPDATES, TOOL_TEXT_LIMIT } from "./constants";

interface GrokUpdate {
  sessionUpdate?: string;
  content?: unknown;
  messageId?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  entries?: Array<{ content?: unknown; status?: unknown }>;
  _meta?: {
    promptIndex?: unknown;
    messageId?: unknown;
    updateParams?: { status?: unknown };
    "x.ai/tool"?: { name?: unknown; kind?: unknown };
  };
}

interface OpenText {
  key: string;
  id: string;
  type: "user_message" | "assistant_message" | "reasoning";
  text: string;
}

export class Transcript {
  private seq = 0;
  private open: OpenText | null = null;
  private readonly tools = new Map<string, ProviderTimelineItem>();

  constructor(private readonly idPrefix = "") {}

  push(update: unknown): ProviderTimelineItem[] {
    const row = asUpdate(update);
    if (!row?.sessionUpdate) return [];
    if (isTextUpdate(row.sessionUpdate)) return this.pushText(row);
    this.open = null;
    if (row.sessionUpdate === "tool_call" || row.sessionUpdate === "tool_call_update") {
      const item = this.toolItem(row);
      return item ? [item] : [];
    }
    if (row.sessionUpdate === "plan") {
      const item = planItem(row);
      return item ? [item] : [];
    }
    return [];
  }

  private pushText(update: GrokUpdate): ProviderTimelineItem[] {
    const kind = update.sessionUpdate;
    if (kind !== "user_message_chunk" && kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") {
      return [];
    }
    const chunk = contentText(update.content);
    if (!chunk) return [];
    const type = kind === "user_message_chunk" ? "user_message" : kind === "agent_message_chunk" ? "assistant_message" : "reasoning";
    const key = `${kind}:${text(update.messageId) || text(update._meta?.messageId)}:${text(update._meta?.promptIndex)}`;
    if (!this.open || this.open.key !== key || this.open.type !== type) {
      this.open = { key, id: this.nextId(type), type, text: "" };
    }
    this.open.text += chunk;
    if (type === "user_message") return [{ id: this.open.id, type, text: this.open.text }];
    if (type === "assistant_message") return [{ id: this.open.id, type, text: this.open.text }];
    return [{ id: this.open.id, type: "reasoning", text: this.open.text }];
  }

  private toolItem(update: GrokUpdate): ProviderTimelineItem | null {
    const callId = update.toolCallId;
    if (!callId) return null;
    const previous = this.tools.get(callId);
    const name = text(update._meta?.["x.ai/tool"]?.name) || update.title || (previous && previous.type === "tool_call" ? previous.name : "") || "tool";
    const kind = text(update._meta?.["x.ai/tool"]?.kind) || update.kind || "";
    const status = toolStatus(update.status ?? text(update._meta?.updateParams?.status));
    const detail = toolDetail(name, kind, update.rawInput, update.rawOutput, previous);
    const item: ProviderTimelineItem =
      status === "failed"
        ? {
            id: callId,
            type: "tool_call",
            callId,
            name,
            status,
            error: { message: "Tool failed" },
            detail,
          }
        : { id: callId, type: "tool_call", callId, name, status, error: null, detail };
    this.tools.set(callId, item);
    return item;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${this.idPrefix}${prefix}:${this.seq}`;
  }
}

export function replayLines(lines: readonly string[], limit = MAX_REPLAY_UPDATES): ProviderTimelineItem[] {
  const kept: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    if (!line.trim() || !isConversationLine(line)) continue;
    kept.push(line);
    if (kept.length > limit) {
      kept.shift();
      dropped += 1;
    }
  }
  const transcript = new Transcript();
  const items: ProviderTimelineItem[] = [];
  if (dropped > 0) {
    items.push({
      id: "replay-truncated",
      type: "notification",
      level: "info",
      message: `Showing the last ${limit} Grok updates. The Grok session still has the full history.`,
    });
  }
  for (const line of kept) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const update = updateFromLine(parsed);
    if (update) items.push(...transcript.push(update));
  }
  return items;
}

export async function replayFile(path: string): Promise<ProviderTimelineItem[]> {
  const lines: string[] = [];
  try {
    const stream = createReadStream(path, "utf8");
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of reader) lines.push(line);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
  return replayLines(lines);
}

function isConversationLine(line: string): boolean {
  for (const kind of CONVERSATION_UPDATES) {
    if (line.includes(`"sessionUpdate":"${kind}"`)) return true;
  }
  return false;
}

function updateFromLine(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return null;
  const params = (parsed as { params?: { update?: unknown } }).params;
  return params?.update ?? null;
}

function asUpdate(value: unknown): GrokUpdate | null {
  if (!value || typeof value !== "object") return null;
  return value as GrokUpdate;
}

function isTextUpdate(kind: string): boolean {
  return kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk";
}

function planItem(update: GrokUpdate): ProviderTimelineItem | null {
  const items = (update.entries ?? []).flatMap((entry) => {
    const entryText = text(entry.content);
    if (!entryText) return [];
    const status = todoStatus(text(entry.status));
    return [
      {
        text: entryText,
        completed: status === "completed",
        ...(status ? { status } : {}),
      },
    ];
  });
  if (items.length === 0) return null;
  return { id: "plan", type: "todo", items };
}

function todoStatus(status: string): "pending" | "in_progress" | "completed" | undefined {
  if (status === "pending" || status === "in_progress" || status === "completed") return status;
  return undefined;
}

function toolStatus(status: string): "running" | "completed" | "failed" | "canceled" {
  switch (status.toLowerCase()) {
    case "completed":
    case "complete":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "canceled";
    default:
      return "running";
  }
}

function toolDetail(
  name: string,
  kind: string,
  rawInput: unknown,
  rawOutput: unknown,
  previous: ProviderTimelineItem | undefined,
): ProviderToolCallDetail {
  const input = record(rawInput) ?? (previous?.type === "tool_call" ? inputFromDetail(previous.detail) : {});
  const output = clip(rawOutput);
  const normalized = kind.toLowerCase();
  if (normalized === "read" || name === "read_file") {
    return {
      type: "read",
      filePath: stringField(input, ["target_file", "file_path", "path", "filePath"]) || name,
      ...(output ? { content: output } : {}),
    };
  }
  if (normalized === "execute" || normalized === "shell" || name === "run_terminal_command" || name === "bash") {
    return {
      type: "shell",
      command: stringField(input, ["command", "cmd"]) || name,
      ...(output ? { output } : {}),
    };
  }
  if (normalized === "edit" || name === "search_replace" || name === "edit") {
    return {
      type: "edit",
      filePath: stringField(input, ["file_path", "path", "target_file", "filePath"]) || name,
      ...(stringField(input, ["old_string", "oldString"]) ? { oldString: stringField(input, ["old_string", "oldString"]) } : {}),
      ...(stringField(input, ["new_string", "newString"]) ? { newString: stringField(input, ["new_string", "newString"]) } : {}),
    };
  }
  if (normalized === "write" || name === "write") {
    return {
      type: "write",
      filePath: stringField(input, ["file_path", "path", "target_file"]) || name,
      ...(stringField(input, ["content"]) ? { content: clip(stringField(input, ["content"])) } : {}),
    };
  }
  if (normalized === "search" || normalized === "grep" || normalized === "glob") {
    return {
      type: "search",
      query: stringField(input, ["query", "pattern", "glob_pattern"]) || name,
      ...(output ? { content: output } : {}),
    };
  }
  return {
    type: "unknown",
    input: jsonValue(rawInput ?? input),
    output: jsonValue(rawOutput ?? null),
  };
}

function inputFromDetail(detail: ProviderToolCallDetail): Record<string, unknown> {
  switch (detail.type) {
    case "read":
      return { target_file: detail.filePath };
    case "shell":
      return { command: detail.command };
    case "edit":
    case "write":
      return { path: detail.filePath };
    case "search":
      return { query: detail.query };
    default:
      return {};
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => contentText(part)).join("");
  const row = record(content);
  if (!row) return "";
  return typeof row.text === "string" ? row.text : "";
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function clip(value: unknown): string {
  const rendered = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  if (!rendered) return "";
  if (rendered.length <= TOOL_TEXT_LIMIT) return rendered;
  return `${rendered.slice(0, TOOL_TEXT_LIMIT)}\n[truncated]`;
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}
