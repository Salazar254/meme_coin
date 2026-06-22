import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.ts";
import { RiskManager, type RiskSignal } from "../src/risk_manager.ts";

const config = () => loadConfig({
  BOT_MODE: "paper",
  STARTING_CAPITAL_SOL: "100",
  RUGCHECK_ENABLED: "false",
  MAX_TOTAL_EXPOSURE_FRACTION: "1",
  MAX_CLUSTER_EXPOSURE_FRACTION: "1",
  MAX_POSITION_PER_PLATFORM: "{\"pump_fun\":1,\"raydium\":1,\"other\":1}",
  MIN_TRADE_SOL: "0.001"
}).risk;

const signal = (overrides: Partial<RiskSignal> = {}): RiskSignal => ({
  mint: "mint_test",
  timestamp: Date.now(),
  regime: "normal",
  riskProbability: 0.02,
  mlConfidence: 0.9,
  winProbability: 0.62,
  rewardRiskRatio: 1.6,
  liquiditySol: 500,
  volatility: 0.2,
  deployer: "deployer_a",
  launchPlatform: "raydium",
  ...overrides
});

export const runRiskManagerTests = (): void => {
  const risk = new RiskManager(config());
  const plan = risk.planPosition(signal({ winProbability: 0.95, rewardRiskRatio: 5, liquiditySol: 10_000 }));
  assert.equal(plan.accepted, true);
  assert.ok(plan.positionFraction <= 0.1 + 1e-12);

  const drawdownRisk = new RiskManager(config());
  drawdownRisk.recordEntry({ mint: "loser", amountSol: 10, openedAt: Date.now(), riskMode: "normal", platform: "raydium" });
  drawdownRisk.recordExit("loser", -13);
  assert.equal(drawdownRisk.snapshot().circuitBreakerOpen, true);
  assert.equal(drawdownRisk.snapshot().circuitReason, "max_drawdown");

  const concentrationRisk = new RiskManager(config());
  concentrationRisk.recordEntry({ mint: "a", amountSol: 1, openedAt: Date.now(), riskMode: "normal", deployer: "same", platform: "raydium" });
  concentrationRisk.recordEntry({ mint: "b", amountSol: 1, openedAt: Date.now(), riskMode: "normal", deployer: "same", platform: "raydium" });
  assert.equal(concentrationRisk.planPosition(signal({ deployer: "same", mint: "c" })).reason, "deployer_concentration_cap");

  const lossRisk = new RiskManager(config());
  lossRisk.recordEntry({ mint: "daily", amountSol: 10, openedAt: Date.now(), riskMode: "normal", platform: "raydium" });
  lossRisk.recordExit("daily", -6);
  assert.equal(lossRisk.snapshot().circuitReason, "daily_loss_limit");
};

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";

if (import.meta.url === entryUrl) {
  runRiskManagerTests();
}
