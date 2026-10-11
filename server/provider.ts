import { execCommand } from "@getpaseo/plugin/server";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCapability,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderRegistration,
  type ProviderStatusRequest,
} from "@getpaseo/plugin/server/provider";
import { grokStdioArgs } from "./args";
import { staticCatalog } from "./catalog";
import { DEFAULT_ARGS, PERSISTENCE_VERSION, PROVIDER_ID, VERSION_TIMEOUT_MS } from "./constants";
import { LiveSession } from "./live-session";
import { grokHome, listGrokSessions, readPersistence } from "./sessions";

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.steer",
  "session.configure",
  "session.list",
  "session.persistence",
  "permission",
] as const satisfies readonly ProviderCapability[];

export function createGrokProvider(): ProviderRegistration {
  return {
    id: PROVIDER_ID,
    label: "Grok",
    description: "Resume a Grok Build session stored on this machine",
    icon: "icon.svg",
    command: ["grok", ...DEFAULT_ARGS],
    status,
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return createConnection(negotiateProviderCapabilities(request.capabilities, CAPABILITIES), request.launch);
    },
  };
}

async function status(request: ProviderStatusRequest) {
  const command = request.launch?.command ?? "grok";
  try {
    const { stdout } = await execCommand(command, ["--version"], { timeout: VERSION_TIMEOUT_MS });
    const version = stdout.trim();
    return { available: true as const, ...(version ? { diagnostic: version } : {}) };
  } catch (error) {
    return {
      available: false as const,
      diagnostic: error instanceof Error ? error.message : "grok is not available",
    };
  }
}

function createConnection(
  capabilities: readonly ProviderCapability[],
  launch: ProviderLaunch | undefined,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, LiveSession>();
  let closed = false;
  const env = launch?.env ?? process.env;
  const sessionLaunch = {
    command: launch?.command ?? "grok",
    args: grokStdioArgs(launch?.args ?? DEFAULT_ARGS),
    env,
    home: grokHome(env),
  };
  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      requireProviderCapabilities(capabilities, input);
      if ("sessionId" in input && input.type !== "session.open" && !sessions.has(input.sessionId)) {
        throw new Error(`Unknown session: ${input.sessionId}`);
      }
      void dispatch(input, sessions, sessionLaunch, emit).catch((error) => {
        const message = error instanceof Error ? error.message : "Grok provider failed";
        if ("requestId" in input) {
          emit({ type: "request.failed", requestId: input.requestId, error: { message } });
          return;
        }
        if ("sessionId" in input) {
          emit({ type: "session.runtime_failed", sessionId: input.sessionId, error: { message } });
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...sessions.values()].map((session) => session.stop()));
      sessions.clear();
      listeners.clear();
    },
  };
}

async function dispatch(
  input: ProviderInput,
  sessions: Map<string, LiveSession>,
  launch: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; home: string },
  emit: (event: ProviderEvent) => void,
): Promise<void> {
  switch (input.type) {
    case "catalog":
      emit({ type: "catalog", requestId: input.requestId, catalog: staticCatalog() });
      return;
    case "sessions":
      emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: await listGrokSessions(launch.home, input),
      });
      return;
    case "session.open":
      await openSession(input, sessions, launch, emit);
      return;
    case "session.prompt":
      await requireSession(sessions, input.sessionId).prompt(input.prompt);
      return;
    case "session.interrupt":
      await requireSession(sessions, input.sessionId).interrupt();
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.permission":
      requireSession(sessions, input.sessionId).respondPermission(input.permissionId, input.response);
      return;
    case "session.configure":
      await requireSession(sessions, input.sessionId).configure(input.changes);
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.close": {
      const session = requireSession(sessions, input.sessionId);
      try {
        await session.close();
      } finally {
        sessions.delete(input.sessionId);
      }
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    default:
      throw new Error(`Unsupported provider input: ${input.type}`);
  }
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  sessions: Map<string, LiveSession>,
  launch: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; home: string },
  emit: (event: ProviderEvent) => void,
): Promise<void> {
  if (sessions.has(input.sessionId)) throw new Error(`Session already exists: ${input.sessionId}`);
  let resume: { sessionId: string; cwd: string } | null = null;
  if (input.persistence) {
    if (input.persistence.version !== PERSISTENCE_VERSION) {
      throw new Error(`Unsupported Grok persistence version ${input.persistence.version}`);
    }
    resume = readPersistence(input.persistence.data);
    if (!resume) throw new Error("Grok persistence is missing sessionId or cwd");
  }
  const session = new LiveSession(input.sessionId, launch, emit);
  sessions.set(input.sessionId, session);
  try {
    await session.open({
      requestId: input.requestId,
      config: input.config,
      history: input.history,
      resume,
    });
  } catch (error) {
    sessions.delete(input.sessionId);
    await session.stop();
    throw error;
  }
}

function requireSession(sessions: Map<string, LiveSession>, sessionId: string): LiveSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}
