import { assertNoFutureLeakage } from "../backtest/data_loader.ts";
import { generateScenarioDataset, runBacktestSuite, scenarioConfigs, type BacktestSuiteResult } from "../backtest/scenarios.ts";
import type { Logger } from "../src/utils/logger.ts";

export interface ScenarioMetrics {
  scenario: string;
  events: number;
  trades: number;
  tradesPerHour: number;
  throughputEventsPerHour: number;
  winRate: number;
  sharpe: number;
  maxDrawdownPct: number;
  pnlSol: number;
  burstPnlAt8000Sol: number;
  rejectedRugs: number;
  rejectedMlRisk: number;
  rejectedOther: number;
  passed: boolean;
}

export interface StressSuiteResult {
  aggregate: {
    trades: number;
    winRate: number;
    sharpe: number;
    maxDrawdownPct: number;
    pnlSol: number;
    passed: boolean;
  };
  scenarios: ScenarioMetrics[];
}

export const assertClairvoyanceGuard = (): void => {
  let failed = false;
  try {
    assertNoFutureLeakage({ mint: "leaky", futureReturnPct: 0.25 }, "unit_fixture");
  } catch {
    failed = true;
  }
  if (!failed) {
    throw new Error("clairvoyance_guard_failed");
  }
};

export const assertScenarioEventsAreLeakageFree = (seed = 20260505): void => {
  for (const scenario of scenarioConfigs()) {
    const dataset = generateScenarioDataset(scenario, seed + scenario.seedOffset);
    for (const event of dataset.events) {
      assertNoFutureLeakage(event as unknown as Record<string, unknown>, event.mint);
    }
  }
};

export const runStressSuite = async (seed = 20260505, logger?: Logger): Promise<StressSuiteResult> => {
  assertClairvoyanceGuard();
  assertScenarioEventsAreLeakageFree(seed);
  const result: BacktestSuiteResult = await runBacktestSuite(seed, logger);
  const configs = new Map(scenarioConfigs().map((item) => [item.name, item]));
  return {
    aggregate: result.aggregate,
    scenarios: result.scenarios.map((scenario) => {
      const config = configs.get(scenario.scenario);
      const hours = (config?.durationSeconds || 3600) / 3600;
      return {
        scenario: scenario.scenario,
        events: scenario.events,
        trades: scenario.metrics.trades,
        tradesPerHour: scenario.metrics.trades / hours,
        throughputEventsPerHour: scenario.events / hours,
        winRate: scenario.metrics.winRate,
        sharpe: scenario.metrics.sharpe,
        maxDrawdownPct: scenario.metrics.maxDrawdownPct,
        pnlSol: scenario.metrics.pnlSol,
        burstPnlAt8000Sol: scenario.metrics.pnlSol * 800,
        rejectedRugs: countRejected(scenario.rejected, ["rug", "honeypot", "lp_burn"]),
        rejectedMlRisk: countRejected(scenario.rejected, ["ml", "risk_probability", "uncertainty"]),
        rejectedOther: Object.values(scenario.rejected).reduce((sum, value) => sum + value, 0),
        passed: scenario.passed
      };
    })
  };
};

const countRejected = (rejected: Record<string, number>, needles: string[]): number => {
  let total = 0;
  for (const [reason, count] of Object.entries(rejected)) {
    if (needles.some((needle) => reason.includes(needle))) {
      total += count;
    }
  }
  return total;
};
