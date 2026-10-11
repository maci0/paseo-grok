export const PROVIDER_ID = "grok";
export const PERSISTENCE_VERSION = 1;
export const MAX_REPLAY_UPDATES = 600;
export const TOOL_TEXT_LIMIT = 4_000;
export const READ_TEXT_LIMIT = 2_000_000;
export const LIST_DEFAULT_LIMIT = 100;
export const LIST_MAX_LIMIT = 500;
export const INITIALIZE_TIMEOUT_MS = 20_000;
export const LOAD_TIMEOUT_MS = 60_000;
export const NEW_SESSION_TIMEOUT_MS = 30_000;
export const CONFIG_TIMEOUT_MS = 15_000;
export const CANCEL_TIMEOUT_MS = 10_000;
export const INTERJECT_TIMEOUT_MS = 10_000;
export const CLOSE_TIMEOUT_MS = 5_000;
export const VERSION_TIMEOUT_MS = 5_000;

export const DEFAULT_ARGS = ["agent", "--no-leader", "stdio"] as const;

export const CONVERSATION_UPDATES = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);
