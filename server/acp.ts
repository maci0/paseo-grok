import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { ProviderMcpServerConfig } from "@getpaseo/plugin/server/provider";
import { grokStdioArgs } from "./args";
import { readTextFile, writeTextFile } from "./files";

const PROTOCOL_VERSION = 1;

interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface AcpHandlers {
  onUpdate(update: unknown): void;
  onPermission(params: unknown): Promise<unknown>;
}

export interface AcpLaunch {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  type?: "http" | "sse";
  url?: string;
  headers?: Array<{ name: string; value: string }>;
}

export class AcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private failed: Error | null = null;

  constructor(
    launch: AcpLaunch,
    private readonly handlers: AcpHandlers,
  ) {
    this.child = spawnProcess(launch.command, grokStdioArgs(launch.args), {
      env: launch.env,
      cwd: launch.cwd,
      stdio: "pipe",
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.accept(chunk));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      if (this.closed) return;
      this.fail(new Error(`grok exited (${signal ?? code ?? "unknown"})`));
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: "paseo-grok", version: "0.1.1" },
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    await terminateProcess(this.child, "SIGTERM");
    this.fail(new Error("Grok process closed"));
  }

  private accept(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        continue;
      }
      if (message.method && message.id !== undefined) {
        void this.replyToAgent(message.id, message.method, message.params);
        continue;
      }
      if (message.method === "session/update") {
        const params = message.params as { update?: unknown } | undefined;
        if (params?.update) this.handlers.onUpdate(params.update);
        continue;
      }
      if (message.id === undefined) continue;
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || "Grok request failed"));
      else waiter.resolve(message.result);
    }
  }

  private async replyToAgent(id: number, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.agentResult(method, params);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`,
      );
    }
  }

  private async agentResult(method: string, params: unknown): Promise<unknown> {
    const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    if (method === "session/request_permission") return this.handlers.onPermission(params);
    if (method === "fs/read_text_file" && typeof record.path === "string") {
      const line = typeof record.line === "number" ? record.line : undefined;
      const limit = typeof record.limit === "number" ? record.limit : undefined;
      return { content: await readTextFile(record.path, line, limit) };
    }
    if (method === "fs/write_text_file" && typeof record.path === "string" && typeof record.content === "string") {
      await writeTextFile(record.path, record.content);
      return {};
    }
    throw new Error(`Unsupported ACP method ${method}`);
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}

export function mcpServers(servers: Readonly<Record<string, ProviderMcpServerConfig>>): McpServer[] {
  return Object.entries(servers).map(([name, config]) => {
    if (config.type === "stdio") {
      return {
        name,
        command: config.command,
        args: config.args ?? [],
        env: Object.entries(config.env ?? {}).map(([envName, value]) => ({ name: envName, value })),
      };
    }
    return {
      type: config.type,
      name,
      url: config.url,
      headers: Object.entries(config.headers ?? {}).map(([headerName, value]) => ({
        name: headerName,
        value,
      })),
    };
  });
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
