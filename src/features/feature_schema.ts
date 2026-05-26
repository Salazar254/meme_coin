import type { TokenLaunchEvent, RugCheckSummary } from "../token_risk_scorer.ts";

export const TABULAR_FEATURES = [
  "rugPullRisk",
  "honeypotRisk",
  "lpBurnGap",
  "transferTaxPct",
  "topHolderPct",
  "devHoldPct",
  "mutableMetadata",
  "mintAuthority",
  "freezeAuthority",
  "volatility1m",
  "lowLiquidity",
  "lowBuyers",
  "rugcheckLpUnlocked",
  "rugcheckDangerSignals"
] as const;

export type TabularFeatureName = typeof TABULAR_FEATURES[number];
export type TabularFeatureVector = Record<TabularFeatureName, number>;

export interface FeatureComputationInput {
  event: TokenLaunchEvent;
  rugcheck?: RugCheckSummary;
}

export const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export const computeTabularFeatures = ({ event, rugcheck }: FeatureComputationInput): TabularFeatureVector => {
  const dangerSignals = rugcheck?.risks?.filter((risk) => ["danger", "critical"].includes(String(risk.level || "").toLowerCase())).length || 0;
  const lpLockedPct = rugcheck?.lpLockedPct ?? (rugcheck?.lpLocked ? 100 : 0);
  return {
    rugPullRisk: clamp01(event.rugPullRisk),
    honeypotRisk: clamp01(event.honeypotRisk),
    lpBurnGap: clamp01(1 - event.lpBurnPct),
    transferTaxPct: clamp01(event.transferTaxPct),
    topHolderPct: clamp01(event.topHolderPct),
    devHoldPct: clamp01(event.devHoldPct),
    mutableMetadata: event.mutableMetadata ? 1 : 0,
    mintAuthority: event.mintAuthorityRenounced ? 0 : 1,
    freezeAuthority: event.freezeAuthorityRenounced ? 0 : 1,
    volatility1m: clamp01(event.volatility1m),
    lowLiquidity: clamp01(1 / Math.max(event.liquiditySol, 0.05) / 5),
    lowBuyers: clamp01(1 - event.uniqueBuyers / 40),
    rugcheckLpUnlocked: rugcheck ? clamp01(1 - lpLockedPct / 100) : 0,
    rugcheckDangerSignals: clamp01(dangerSignals / 4)
  };
};

export const vectorizeTabularFeatures = (features: Record<string, number>): Float32Array => {
  return Float32Array.from(TABULAR_FEATURES.map((name) => Number.isFinite(features[name]) ? features[name] : 0));
};
