import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { computeTabularFeatures } from "../src/features/feature_schema.ts";
import type { RugCheckSummary, TokenLaunchEvent } from "../src/token_risk_scorer.ts";

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

const pythonReference = (event: TokenLaunchEvent, rugcheck?: RugCheckSummary): Record<string, number> => {
  const danger = rugcheck?.risks?.filter((risk) => ["danger", "critical"].includes(String(risk.level || "").toLowerCase())).length || 0;
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
    rugcheckDangerSignals: clamp01(danger / 4)
  };
};

export const runMlSkewTests = (): void => {
  const event: TokenLaunchEvent = {
    mint: "sample",
    deployer: "deployer",
    timestamp: 1_735_689_600_000,
    liquiditySol: 0.2,
    lpBurnPct: 0.7,
    ageSeconds: 8,
    uniqueBuyers: 18,
    totalVolumeSol: 12,
    marketCapSol: 80,
    rugPullRisk: 0.12,
    honeypotRisk: 0.03,
    transferTaxPct: 0.04,
    topHolderPct: 0.18,
    devHoldPct: 0.06,
    mutableMetadata: true,
    mintAuthorityRenounced: false,
    freezeAuthorityRenounced: true,
    volatility1m: 0.42,
    priceVelocity1m: 0.09,
    buySellRatio: 1.4,
    jitoCompetition: 0.5,
    launchRatePerMinute: 450,
    predictedWinProb: 0.58,
    rewardRiskRatio: 1.4,
    synthetic: true,
    launchPlatform: "pump.fun"
  };
  const rugcheck: RugCheckSummary = {
    lpLocked: true,
    lpLockedPct: 92,
    risks: [{ level: "danger" }, { level: "warn" }, { level: "critical" }]
  };
  const actual = computeTabularFeatures({ event, rugcheck });
  const expected = pythonReference(event, rugcheck);
  for (const [feature, value] of Object.entries(expected)) {
    assert.ok(Math.abs(actual[feature as keyof typeof actual] - value) <= 1e-6, feature);
  }
};

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";

if (import.meta.url === entryUrl) {
  runMlSkewTests();
}
