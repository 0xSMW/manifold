export type TriState = "supported" | "unsupported" | "unknown";

export interface ActivePrice {
  id: string;
  fidelity: "provider_verified" | "operator_override" | "aggregator" | "unknown" | string | null;
  source: string | null;
  effectiveFrom: string | null;
  currency: string;
  unit: string;
  inputPerMtokMicrousd: string | null;
  outputPerMtokMicrousd: string | null;
  cacheReadPerMtokMicrousd?: string | null;
  cacheWritePerMtokMicrousd?: string | null;
  reasoningPerMtokMicrousd?: string | null;
  audioInPerMtokMicrousd?: string | null;
  audioOutPerMtokMicrousd?: string | null;
}

export interface ModelOffering {
  id: string;
  canonicalModel: {
    id: string;
    slug: string;
    displayName: string;
    family: string | null;
    modalityIn: unknown;
    modalityOut: unknown;
    openWeights: boolean | null;
    source: string;
  };
  provider: string;
  providerModelId: string;
  endpointKinds: unknown;
  adapterRevision: string;
  capabilities: unknown;
  limits: { contextTokens: string | null; outputTokens: string | null };
  region: string | null;
  routable: boolean;
  activePrice: ActivePrice | null;
}

export interface ModelPage {
  data: ModelOffering[];
  nextCursor: string | null;
}

const capabilityLabels: Record<string, string> = {
  attachment: "Attachments",
  reasoning: "Reasoning",
  toolCall: "Tool calls",
  structuredOutput: "Structured output",
  temperature: "Temperature",
};

export function capabilityEntries(capabilities: unknown): Array<[string, TriState]> {
  const values = capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
    ? capabilities as Record<string, unknown>
    : {};
  return Object.entries(capabilityLabels).map(([key, label]) => {
    const value = values[key];
    return [label, value === "supported" || value === "unsupported" || value === "unknown" ? value : "unknown"];
  });
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function formatMicrousd(value: string | null | undefined): string {
  if (value === null || value === undefined || !/^-?\d+$/.test(value)) return "Unknown";
  try { return `${new Intl.NumberFormat().format(BigInt(value))} µUSD`; } catch { return "Unknown"; }
}

export function formatLimit(value: string | null): string {
  if (!value || !/^-?\d+$/.test(value)) return "Unknown";
  try { return new Intl.NumberFormat().format(BigInt(value)); } catch { return "Unknown"; }
}

export function hasCompleteCorePrice(model: ModelOffering): boolean {
  return Boolean(model.activePrice && model.activePrice.fidelity !== "unknown" && model.activePrice.inputPerMtokMicrousd !== null && model.activePrice.outputPerMtokMicrousd !== null);
}

export function fidelityLabel(fidelity: string | null | undefined): string {
  if (!fidelity) return "Unknown";
  return fidelity.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
