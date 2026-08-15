export const PINNED_MODELS = {
  anthropic: ["claude-opus-4-8"],
  openrouter: ["z-ai/glm-5.2", "anthropic/claude-opus-4.8"],
} as const;

export type ModelProvider = keyof typeof PINNED_MODELS;

export interface ModelConfiguration {
  provider: ModelProvider;
  model: string;
}

export interface OpenRouterRoutingPolicy {
  order: string[];
  allow_fallbacks: false;
  require_parameters: true;
}

const OPENROUTER_ROUTING: Readonly<Record<string, OpenRouterRoutingPolicy>> = {
  "z-ai/glm-5.2": { order: ["z-ai"], allow_fallbacks: false, require_parameters: true },
  "anthropic/claude-opus-4.8": { order: ["anthropic"], allow_fallbacks: false, require_parameters: true },
};

export function openRouterRouting(configuration: ModelConfiguration): OpenRouterRoutingPolicy | null {
  if (configuration.provider !== "openrouter") return null;
  const policy = OPENROUTER_ROUTING[configuration.model];
  if (!policy) throw new ModelConfigurationError(`missing OpenRouter routing policy for ${configuration.model}`);
  return { ...policy, order: [...policy.order] };
}

export class ModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigurationError";
  }
}

export function resolveModelConfiguration(environment: NodeJS.ProcessEnv = process.env): ModelConfiguration {
  const rawProvider = environment.QA_MODEL_PROVIDER ?? "openrouter";
  if (!(rawProvider in PINNED_MODELS)) throw new ModelConfigurationError(`QA_MODEL_PROVIDER must be one of: ${Object.keys(PINNED_MODELS).join(", ")}`);
  const provider = rawProvider as ModelProvider;
  const allowedModels: readonly string[] = PINNED_MODELS[provider];
  const model = environment.QA_MODEL_ID ?? allowedModels[0];
  if (!model || !allowedModels.includes(model)) throw new ModelConfigurationError(`QA_MODEL_ID ${model ?? "missing"} is not an approved model for ${provider}`);
  return { provider, model };
}

export function requireModelApiKey(environment: NodeJS.ProcessEnv = process.env): string {
  const apiKey = environment.QA_MODEL_API_KEY;
  if (!apiKey) throw new ModelConfigurationError("QA_MODEL_API_KEY is required for the configured QA model");
  return apiKey;
}
