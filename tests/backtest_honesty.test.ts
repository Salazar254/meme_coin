import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/utils/logger.ts";
import { TokenRiskScorer } from "../src/token_risk_scorer.ts";
import { HonestBacktestEngine } from "../backtest/engine.ts";
import { assertNoFutureLeakage } from "../backtest/data_loader.ts";
import { generateScenarioDataset, scenarioConfigs } from "../backtest/scenarios.ts";

export const runBacktestHonestyTests = async (): Promise<void> => {
  assert.throws(() => assertNoFutureLeakage({ mint: "leaky", futureReturnPct: 0.25 }, "unit"), /future_leakage_detected/);
  const dataset = generateScenarioDataset(scenarioConfigs()[0], 20260505);
  for (const event of dataset.events.slice(0, 100)) {
    assert.doesNotThrow(() => assertNoFutureLeakage(event as unknown as Record<string, unknown>, event.mint));
  }

  const source = readFileSync("src/token_risk_scorer.ts", "utf8");
  const match = /export interface TokenLaunchEvent \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(match);
  assert.equal(match[1].includes("futureReturnPct"), false);

  const logger = createLogger("error", { service: "honesty_test" });
  const config = loadConfig({
    ...process.env,
    BOT_MODE: "paper",
    RUGCHECK_ENABLED: "false",
    STARTING_CAPITAL_SOL: "10",
    VOLATILITY_SPIKE_BLOCK: "0.93",
    CONSECUTIVE_LOSS_CIRCUIT_BREAKER: "24"
  });
  const scorer = await TokenRiskScorer.load(config.scorer.modelPath, config.scorer, logger);
  const sorted = await new HonestBacktestEngine(config, scorer, logger).run(dataset);
  const shuffled = await new HonestBacktestEngine(config, scorer, logger).run({ ...dataset, events: [...dataset.events].reverse() });
  assert.ok(sorted.trades.every((trade) => trade.exitReason !== "synthetic_return"));
  assert.ok(shuffled.metrics.sharpe <= sorted.metrics.sharpe * 1.1 + 1e-9);
};

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";

if (import.meta.url === entryUrl) {
  await runBacktestHonestyTests();
}
