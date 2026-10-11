export const INTERJECT_METHOD = "_x.ai/interject";

const ACCEPTED_STATUS = "queued";

export function interjectParams(sessionId: string, text: string): { sessionId: string; text: string } {
  return { sessionId, text };
}

export function steerOutcome(
  turnId: string | null,
  response: unknown,
): { type: "steer"; turnId: string } | { type: "failed"; message: string } {
  if (!turnId) return { type: "failed", message: "There is no active turn to steer" };
  if (interjectStatus(response) !== ACCEPTED_STATUS) {
    return { type: "failed", message: "Grok did not accept the steer" };
  }
  return { type: "steer", turnId };
}

function interjectStatus(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const record = response as { status?: unknown; result?: unknown };
  if (typeof record.status === "string") return record.status;
  if (!record.result || typeof record.result !== "object") return "";
  const status = (record.result as { status?: unknown }).status;
  return typeof status === "string" ? status : "";
}
