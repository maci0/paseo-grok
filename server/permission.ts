import type { ProviderPermissionRequest, ProviderPermissionResponse } from "@getpaseo/plugin/server/provider";

interface AcpOption {
  optionId?: string;
  name?: string;
  kind?: string;
}

interface AcpPermissionParams {
  toolCall?: { toolCallId?: string; title?: string; rawInput?: unknown };
  options?: AcpOption[];
}

export interface AcpPermissionOutcome {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
}

export function permissionView(params: unknown, fallbackId: string): {
  request: ProviderPermissionRequest;
  outcomeFor(response: ProviderPermissionResponse): AcpPermissionOutcome;
} {
  const parsed = params && typeof params === "object" ? (params as AcpPermissionParams) : {};
  const options = (parsed.options ?? []).filter((option): option is AcpOption & { optionId: string } =>
    typeof option.optionId === "string" && option.optionId.length > 0,
  );
  const actions = options.map((option) => ({
    id: option.optionId,
    label: option.name || option.kind || option.optionId,
    behavior: option.kind?.startsWith("reject") ? ("deny" as const) : ("allow" as const),
  }));
  const request: ProviderPermissionRequest = {
    id: parsed.toolCall?.toolCallId || fallbackId,
    name: parsed.toolCall?.title || "tool",
    kind: "tool",
    ...(parsed.toolCall?.title ? { title: parsed.toolCall.title } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  };
  return {
    request,
    outcomeFor(response) {
      const selected = response.selectedActionId;
      if (selected && options.some((option) => option.optionId === selected)) {
        return { outcome: { outcome: "selected", optionId: selected } };
      }
      const match = options.find((option) =>
        response.behavior === "deny" ? option.kind?.startsWith("reject") : !option.kind?.startsWith("reject"),
      );
      if (match) return { outcome: { outcome: "selected", optionId: match.optionId } };
      return { outcome: { outcome: "cancelled" } };
    },
  };
}
