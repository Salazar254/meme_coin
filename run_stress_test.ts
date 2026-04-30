import { runStressSuite } from "./tests/stress_test.ts";
import { createLogger } from "./src/utils/logger.ts";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const main = async (): Promise<void> => {
  const logger = createLogger("info", { service: "stress_runner" });
  const result = await runStressSuite(20260429, logger);
  for (const scenario of result.scenarios) {
    logger.info({
      scenario: scenario.scenario,
      trades: scenario.trades,
      tradesPerHour: Number(scenario.tradesPerHour.toFixed(2)),
      throughputEventsPerHour: scenario.throughputEventsPerHour,
      winRate: Number((scenario.winRate * 100).toFixed(2)),
      sharpe: Number(scenario.sharpe.toFixed(3)),
      maxDrawdownPct: Number(scenario.maxDrawdownPct.toFixed(2)),
      pnlSol: Number(scenario.pnlSol.toFixed(6)),
      burstPnlAt8000Sol: Number(scenario.burstPnlAt8000Sol.toFixed(3)),
      passed: scenario.passed
    }, "scenario_result");
  }
  logger.info({
    trades: result.aggregate.trades,
    winRate: Number((result.aggregate.winRate * 100).toFixed(2)),
    sharpe: Number(result.aggregate.sharpe.toFixed(3)),
    maxDrawdownPct: Number(result.aggregate.maxDrawdownPct.toFixed(2)),
    pnlSol: Number(result.aggregate.pnlSol.toFixed(6)),
    passed: result.aggregate.passed
  }, "aggregate_result");
  if (!result.aggregate.passed) {
    process.exitCode = 1;
  }
};

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";

if (import.meta.url === entryUrl) {
  main().catch((error) => {
    const logger = createLogger("error", { service: "stress_runner" });
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "stress_runner_failed");
    process.exitCode = 1;
  });
}
