import { randomUUID } from "node:crypto";
import type {
  ProviderConfigState,
  ProviderEvent,
  ProviderPermissionResponse,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { AcpClient, mcpServers, withTimeout } from "./acp";
import { configFromOptions, type LiveSelect } from "./catalog";
import {
  CANCEL_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS,
  CONFIG_TIMEOUT_MS,
  INITIALIZE_TIMEOUT_MS,
  LOAD_TIMEOUT_MS,
  NEW_SESSION_TIMEOUT_MS,
} from "./constants";
import { permissionView } from "./permission";
import { ImagePromptError, promptText } from "./prompt-text";
import { findUpdatesFile, sessionPersistence } from "./sessions";
import { replayFile, Transcript } from "./transcript";

interface OpenInput {
  requestId: string;
  config: ProviderSessionConfig;
  history: "replay" | "skip";
  resume: { sessionId: string; cwd: string } | null;
}

interface Launch {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  home: string;
}

export class LiveSession {
  private client: AcpClient | null = null;
  private grokSessionId = "";
  private cwd = "";
  private turnId: string | null = null;
  private ready = false;
  private readonly transcript = new Transcript("live-");
  private readonly permissions = new Map<
    string,
    {
      resolve: (outcome: unknown) => void;
      outcomeFor: (response: ProviderPermissionResponse) => unknown;
    }
  >();
  private configState: ProviderConfigState = {
    models: [],
    modes: [],
    thinkingOptions: [],
    settings: [],
  };

  constructor(
    private readonly sessionId: string,
    private readonly launch: Launch,
    private readonly emit: (event: ProviderEvent) => void,
  ) {}

  async open(input: OpenInput): Promise<void> {
    const cwd = input.resume?.cwd ?? input.config.cwd;
    this.cwd = cwd;
    const client = new AcpClient(
      {
        command: this.launch.command,
        args: this.launch.args,
        env: { ...this.launch.env, ...input.config.env },
        cwd,
      },
      {
        onUpdate: (update) => this.onUpdate(update),
        onPermission: (params) => this.onPermission(params),
      },
    );
    this.client = client;
    try {
      await withTimeout(client.initialize(), INITIALIZE_TIMEOUT_MS, "Grok initialize timed out");
      const created = input.resume
        ? await withTimeout(
            client.request("session/load", {
              sessionId: input.resume.sessionId,
              cwd,
              mcpServers: mcpServers(input.config.mcpServers),
            }),
            LOAD_TIMEOUT_MS,
            "Grok session/load timed out",
          )
        : await withTimeout(
            client.request("session/new", {
              cwd,
              mcpServers: mcpServers(input.config.mcpServers),
              ...(input.config.systemPrompt
                ? { _meta: { systemPromptOverride: input.config.systemPrompt } }
                : {}),
            }),
            NEW_SESSION_TIMEOUT_MS,
            "Grok session/new timed out",
          );
      const grokSessionId = input.resume?.sessionId ?? sessionIdFrom(created);
      if (!grokSessionId) throw new Error("Grok did not return a session id");
      this.grokSessionId = grokSessionId;
      let options = optionsFrom(created);
      options = await this.applyOption(client, "model", input.config.model, options);
      options = await this.applyOption(client, "reasoning_effort", input.config.thinkingOption, options);
      this.configState = configFromOptions(options, input.config.model, input.config.thinkingOption);
      const persistence = sessionPersistence(grokSessionId, cwd);
      this.emit({
        type: "session.opened",
        requestId: input.requestId,
        sessionId: this.sessionId,
        capabilities: [
          "prompt.message",
          "prompt.command",
          "session.configure",
          "session.list",
          "session.persistence",
          "permission",
        ],
        restoration: "core",
        persistence,
        cwd,
        ...(input.config.title ? { title: input.config.title } : {}),
      });
      this.emit({ type: "session.config", sessionId: this.sessionId, config: this.configState });
      if (input.history === "replay" && input.resume) await this.replay(grokSessionId, cwd);
      this.ready = true;
      this.emit({ type: "session.ready", requestId: input.requestId, sessionId: this.sessionId });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async prompt(prompt: Parameters<typeof promptText>[0]): Promise<void> {
    const client = this.requireClient();
    let text: string;
    try {
      text = promptText(prompt);
    } catch (error) {
      this.failPrompt(prompt.clientMessageId, error);
      return;
    }
    if (text.trim().length === 0) {
      this.failPrompt(prompt.clientMessageId, new Error("Prompt is empty"));
      return;
    }
    if (this.turnId) {
      this.failPrompt(prompt.clientMessageId, new Error("A turn is already active"));
      return;
    }
    const turnId = randomUUID();
    this.turnId = turnId;
    this.emit({
      type: "timeline.item",
      sessionId: this.sessionId,
      item: { type: "user_message", id: `user:${prompt.clientMessageId}`, text, clientMessageId: prompt.clientMessageId },
    });
    this.emit({
      type: "session.prompt_result",
      sessionId: this.sessionId,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "started" });
    try {
      const response = await client.request("session/prompt", {
        sessionId: this.grokSessionId,
        prompt: [{ type: "text", text }],
      });
      const stopReason = stopReasonFrom(response);
      if (stopReason === "cancelled") {
        this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "canceled" });
      } else if (stopReason === "refusal") {
        this.emit({
          type: "session.turn",
          sessionId: this.sessionId,
          turnId,
          state: "failed",
          error: { message: "Grok refused the prompt" },
        });
      } else {
        this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "completed" });
      }
    } catch (error) {
      this.emit({
        type: "session.turn",
        sessionId: this.sessionId,
        turnId,
        state: "failed",
        error: { message: error instanceof Error ? error.message : "Grok prompt failed" },
      });
    } finally {
      if (this.turnId === turnId) this.turnId = null;
    }
  }

  async interrupt(): Promise<void> {
    const client = this.client;
    if (!client || !this.grokSessionId) return;
    await withTimeout(
      client.request("session/cancel", { sessionId: this.grokSessionId }),
      CANCEL_TIMEOUT_MS,
      "Grok session/cancel timed out",
    );
  }

  async configure(changes: { model?: string | null; thinkingOption?: string | null }): Promise<void> {
    const client = this.requireClient();
    let options = optionsFromConfig(this.configState);
    if (typeof changes.model === "string") options = await this.applyOption(client, "model", changes.model, options);
    if (typeof changes.thinkingOption === "string") {
      options = await this.applyOption(client, "reasoning_effort", changes.thinkingOption, options);
    }
    this.configState = configFromOptions(
      options,
      changes.model === null ? undefined : (changes.model ?? this.configState.model),
      changes.thinkingOption === null ? undefined : (changes.thinkingOption ?? this.configState.thinkingOption),
    );
    this.emit({ type: "session.config", sessionId: this.sessionId, config: this.configState });
  }

  async close(): Promise<void> {
    const client = this.client;
    if (client && this.grokSessionId) {
      await withTimeout(
        client.request("session/close", { sessionId: this.grokSessionId }),
        CLOSE_TIMEOUT_MS,
        "Grok session/close timed out",
      ).catch(() => undefined);
    }
    await this.stop().catch(() => undefined);
    this.emit({ type: "session.closed", sessionId: this.sessionId });
  }

  respondPermission(permissionId: string, response: ProviderPermissionResponse): void {
    const pending = this.permissions.get(permissionId);
    if (!pending) return;
    this.permissions.delete(permissionId);
    pending.resolve(pending.outcomeFor(response));
    this.emit({ type: "session.permission_resolved", sessionId: this.sessionId, permissionId });
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.cancelPermissions();
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(() => undefined);
  }

  private async replay(sessionId: string, cwd: string): Promise<void> {
    const path = await findUpdatesFile(this.launch.home, sessionId, cwd);
    const items = path
      ? await replayFile(path)
      : [
          {
            id: "replay-missing",
            type: "notification" as const,
            level: "info" as const,
            message: "Grok loaded the session. No update log was found to show its history.",
          },
        ];
    for (const item of items) {
      this.emit({ type: "timeline.item", sessionId: this.sessionId, item });
    }
  }

  private onUpdate(update: unknown): void {
    if (!this.ready || !update || typeof update !== "object") return;
    const row = update as {
      sessionUpdate?: string;
      availableCommands?: Array<{ name?: string; description?: string }>;
      size?: unknown;
      used?: unknown;
      configOptions?: unknown;
    };
    if (row.sessionUpdate === "user_message_chunk" && this.turnId) return;
    if (row.sessionUpdate === "available_commands_update") {
      const commands = (row.availableCommands ?? []).flatMap((command) => {
        if (!command.name || !command.description) return [];
        return [{ name: command.name, description: command.description }];
      });
      this.emit({ type: "session.commands", sessionId: this.sessionId, commands });
      return;
    }
    if (row.sessionUpdate === "usage_update" && typeof row.used === "number" && typeof row.size === "number") {
      this.emit({
        type: "session.usage",
        sessionId: this.sessionId,
        ...(this.turnId ? { turnId: this.turnId } : {}),
        usage: { contextWindowUsedTokens: row.used, contextWindowMaxTokens: row.size },
      });
      return;
    }
    if (row.sessionUpdate === "config_option_update") {
      const options = optionsFrom(row);
      if (options.length === 0) return;
      this.configState = configFromOptions(options, this.configState.model, this.configState.thinkingOption);
      this.emit({ type: "session.config", sessionId: this.sessionId, config: this.configState });
      return;
    }
    for (const item of this.transcript.push(update)) {
      this.emit({ type: "timeline.item", sessionId: this.sessionId, item });
    }
  }

  private onPermission(params: unknown): Promise<unknown> {
    const record = params && typeof params === "object" ? params : {};
    const view = permissionView(record, randomUUID());
    this.emit({ type: "session.permission", sessionId: this.sessionId, request: view.request });
    return new Promise((resolve) => {
      this.permissions.set(view.request.id, { resolve, outcomeFor: view.outcomeFor });
    });
  }

  private async applyOption(
    client: AcpClient,
    configId: "model" | "reasoning_effort",
    value: string | undefined,
    current: LiveSelect[],
  ): Promise<LiveSelect[]> {
    if (!value) return current;
    const selected = current.find((option) => option.id === configId || option.category === categoryFor(configId));
    if (selected?.currentValue === value) return current;
    try {
      const result = await withTimeout(
        client.request("session/set_config_option", {
          sessionId: this.grokSessionId,
          configId,
          value: { value },
        }),
        CONFIG_TIMEOUT_MS,
        `Setting ${configId} timed out`,
      );
      const next = optionsFrom(result);
      return next.length > 0 ? next : current;
    } catch (error) {
      console.error(`Grok rejected ${configId}`, error instanceof Error ? error.message : error);
      return current;
    }
  }

  private requireClient(): AcpClient {
    if (!this.client || !this.grokSessionId) throw new Error("Grok session is not open");
    return this.client;
  }

  private failPrompt(clientMessageId: string, error: unknown): void {
    const message = error instanceof ImagePromptError ? error.message : error instanceof Error ? error.message : "Prompt failed";
    this.emit({
      type: "session.prompt_result",
      sessionId: this.sessionId,
      clientMessageId,
      result: { type: "failed", error: { message } },
    });
  }

  private cancelPermissions(): void {
    for (const [permissionId, pending] of this.permissions) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.emit({ type: "session.permission_resolved", sessionId: this.sessionId, permissionId });
    }
    this.permissions.clear();
  }
}

function sessionIdFrom(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const sessionId = (result as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

function stopReasonFrom(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const stopReason = (result as { stopReason?: unknown }).stopReason;
  return typeof stopReason === "string" ? stopReason : "";
}

export function optionsFrom(result: unknown): LiveSelect[] {
  if (Array.isArray(result)) return result.filter(isLiveSelect);
  if (!result || typeof result !== "object") return [];
  const configOptions = (result as { configOptions?: unknown }).configOptions;
  return Array.isArray(configOptions) ? configOptions.filter(isLiveSelect) : [];
}

function optionsFromConfig(config: ProviderConfigState): LiveSelect[] {
  return [
    ...(config.model ? [{ id: "model", category: "model", currentValue: config.model }] : []),
    ...(config.thinkingOption
      ? [{ id: "reasoning_effort", category: "thought_level", currentValue: config.thinkingOption }]
      : []),
  ];
}

function categoryFor(configId: "model" | "reasoning_effort"): string {
  return configId === "model" ? "model" : "thought_level";
}

function isLiveSelect(value: unknown): value is LiveSelect {
  return Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string");
}
