import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, PERSISTENCE_VERSION } from "./constants";

export interface SessionQuery {
  query?: string;
  cwd?: string;
  limit?: number;
}

interface SummaryFile {
  info?: { id?: unknown; cwd?: unknown };
  generated_title?: unknown;
  session_summary?: unknown;
  last_turn_summary?: unknown;
  last_recap?: unknown;
  updated_at?: unknown;
}

export function grokHome(env: NodeJS.ProcessEnv): string {
  const configured = env.GROK_HOME;
  if (configured && configured.length > 0) return configured;
  return join(homedir(), ".grok");
}

export function sessionPersistence(sessionId: string, cwd: string) {
  return {
    version: PERSISTENCE_VERSION,
    data: { sessionId, cwd },
  };
}

export function readPersistence(data: unknown): { sessionId: string; cwd: string } | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { sessionId?: unknown; cwd?: unknown };
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return null;
  if (typeof record.cwd !== "string" || record.cwd.length === 0) return null;
  return { sessionId: record.sessionId, cwd: record.cwd };
}

export async function findUpdatesFile(home: string, sessionId: string, cwd: string): Promise<string | null> {
  const direct = join(home, "sessions", encodeURIComponent(cwd), sessionId, "updates.jsonl");
  if (await exists(direct)) return direct;
  const groups = await readdir(join(home, "sessions"), { withFileTypes: true }).catch(() => []);
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const candidate = join(home, "sessions", group.name, sessionId, "updates.jsonl");
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function listGrokSessions(
  home: string,
  query: SessionQuery,
): Promise<ProviderSessionSummary[]> {
  const root = join(home, "sessions");
  const groups = await readdir(root, { withFileTypes: true }).catch(() => []);
  const rows: ProviderSessionSummary[] = [];
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const sessions = await readdir(join(root, group.name), { withFileTypes: true }).catch(() => []);
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const row = await readSummary(join(root, group.name, session.name, "summary.json"));
      if (row) rows.push(row);
    }
  }
  const needle = query.query?.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (query.cwd && row.cwd !== query.cwd) return false;
    if (!needle) return true;
    const sessionId = readPersistence(row.persistence.data)?.sessionId ?? "";
    const haystack = `${row.title ?? ""} ${row.description ?? ""} ${sessionId} ${row.cwd}`.toLowerCase();
    return haystack.includes(needle);
  });
  filtered.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  const limit = Math.min(query.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  return filtered.slice(0, limit);
}

async function readSummary(path: string): Promise<ProviderSessionSummary | null> {
  let parsed: SummaryFile;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as SummaryFile;
  } catch {
    return null;
  }
  const sessionId = parsed.info?.id;
  const cwd = parsed.info?.cwd;
  if (typeof sessionId !== "string" || typeof cwd !== "string") return null;
  const title = text(parsed.generated_title) || text(parsed.session_summary) || sessionId;
  const description = descriptionFor(parsed, title);
  const updatedAt = text(parsed.updated_at);
  return {
    persistence: sessionPersistence(sessionId, cwd),
    cwd,
    title,
    ...(description ? { description } : {}),
    ...(updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? { updatedAt } : {}),
  };
}

function descriptionFor(summary: SummaryFile, title: string): string | undefined {
  const candidates = [summary.last_turn_summary, summary.last_recap, summary.session_summary];
  for (const candidate of candidates) {
    const value = text(candidate);
    if (value && value !== title) return value;
  }
  return undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
