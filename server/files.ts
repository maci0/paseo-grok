import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { READ_TEXT_LIMIT } from "./constants";

export async function readTextFile(path: string, line?: number, limit?: number): Promise<string> {
  const file = await readFile(path, "utf8");
  if (line === undefined && limit === undefined) {
    if (file.length <= READ_TEXT_LIMIT) return file;
    return `${file.slice(0, READ_TEXT_LIMIT)}\n[truncated]`;
  }
  const lines = file.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join("\n");
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
