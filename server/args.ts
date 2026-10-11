import { DEFAULT_ARGS } from "./constants";

/** Keep a private agent process. Leader mode would attach to the shared Grok backend. */
export function grokStdioArgs(args: readonly string[]): string[] {
  const next = args.length > 0 ? [...args] : [...DEFAULT_ARGS];
  if (!next.includes("stdio")) next.push("stdio");
  const stdioAt = next.indexOf("stdio");
  const head = next.slice(0, stdioAt);
  const tail = next.slice(stdioAt);
  if (!head.includes("agent")) head.unshift("agent");
  if (!head.includes("--no-leader")) head.push("--no-leader");
  return [...head, ...tail];
}
