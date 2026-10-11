import type { ProviderCatalog, ProviderConfigState, ProviderModel } from "@getpaseo/plugin/server/provider";

const THINKING = [
  { id: "xhigh", label: "Extra High" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
] as const;

const MODELS: readonly ProviderModel[] = [
  { id: "grok-4.7", label: "Grok 4.7" },
  { id: "grok-4.7-build-fast", label: "Grok 4.7 Fast" },
  { id: "grok-4.6", label: "Grok 4.6" },
  { id: "grok-4.5", label: "Grok 4.5" },
];

export const DEFAULT_MODEL = "grok-4.7";
export const DEFAULT_THINKING = "high";

export function staticCatalog(): ProviderCatalog {
  return {
    models: MODELS,
    modes: [],
    thinkingOptions: [...THINKING],
    defaultModel: DEFAULT_MODEL,
    defaultThinkingOption: DEFAULT_THINKING,
  };
}

export interface LiveSelect {
  id: string;
  name?: string;
  category?: string;
  currentValue?: string;
  options?: Array<{ value?: string; name?: string }>;
}

export function configFromOptions(
  options: readonly LiveSelect[],
  fallbackModel: string | undefined,
  fallbackThinking: string | undefined,
): ProviderConfigState {
  const modelOption = options.find((option) => option.category === "model" || option.id === "model");
  const thinkingOption = options.find(
    (option) => option.category === "thought_level" || option.id === "reasoning_effort",
  );
  const models = selectModels(modelOption);
  const thinkingOptions = selectThinking(thinkingOption);
  return {
    model: modelOption?.currentValue ?? fallbackModel ?? models[0]?.id,
    thinkingOption: thinkingOption?.currentValue ?? fallbackThinking ?? thinkingOptions[0]?.id,
    models: models.length > 0 ? models : MODELS,
    modes: [],
    thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : [...THINKING],
    settings: [],
  };
}

function selectModels(option: LiveSelect | undefined): ProviderModel[] {
  return (option?.options ?? []).flatMap((entry) => {
    if (!entry.value) return [];
    return [{ id: entry.value, label: entry.name || entry.value }];
  });
}

function selectThinking(option: LiveSelect | undefined): Array<{ id: string; label: string }> {
  return (option?.options ?? []).flatMap((entry) => {
    if (!entry.value) return [];
    return [{ id: entry.value, label: entry.name || entry.value }];
  });
}
