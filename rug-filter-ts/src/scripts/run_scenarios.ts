/**
 * scripts/run_scenarios.ts
 *
 * Realistic scenario runner for the memecoin sniper backtester.
 */

import { DEFAULT_SCENARIO_REALISM } from '../engine/signal_generator';
import { ScenarioTester } from '../engine/scenario_tester';
import { MarketRegime, ScenarioResult, SizingBucket } from '../engine/types';

const MONTE_CARLO_RUNS = 4;

export async function main(): Promise<void> {
  console.log('');
  console.log('Memecoin Sniper Engine - Scenario Test Suite');
  console.log('============================================');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');
  console.log(
    `Realism: latent rugs ${(DEFAULT_SCENARIO_REALISM.latentRugPullRate * 100).toFixed(0)}%, MEV rejects ${(DEFAULT_SCENARIO_REALISM.mevRejectRate * 100).toFixed(0)}%, large-order slippage +${(DEFAULT_SCENARIO_REALISM.largeOrderEntrySlippagePct * 100).toFixed(0)}%/-${(DEFAULT_SCENARIO_REALISM.largeOrderExitSlippagePct * 100).toFixed(0)}%, stress P95 ${DEFAULT_SCENARIO_REALISM.stressLatencyP95Ms}ms`,
  );
  console.log('Target bands: Sharpe 0.6-1.2, max DD 30-40%, WR 58-62%');
  console.log('');

  const startTime = Date.now();
  const resultSets: Array<Map<string, ScenarioResult>> = [];

  console.log(`Running all 6 scenarios across ${MONTE_CARLO_RUNS} Monte Carlo passes...\n`);
  for (let pass = 1; pass <= MONTE_CARLO_RUNS; pass++) {
    console.log(`Pass ${pass}/${MONTE_CARLO_RUNS}`);
    const tester = new ScenarioTester();
    resultSets.push(await tester.runAllScenarios());
  }

  const results = averageScenarioResults(resultSets);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nAll scenarios completed in ${elapsed}s\n`);

  const report = ScenarioTester.formatReport(results);
  console.log(report);

  let exitCode = 0;
  for (const [key, result] of results) {
    if (key !== 'stress_market' && result.sharpe < -2) {
      console.error(
        `WARNING: Scenario "${key}" has very negative Sharpe (${result.sharpe.toFixed(3)})`,
      );
      exitCode = 1;
    }
  }

  process.exit(exitCode);
}

void main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

function averageScenarioResults(
  resultSets: Array<Map<string, ScenarioResult>>,
): Map<string, ScenarioResult> {
  const averaged = new Map<string, ScenarioResult>();
  if (resultSets.length === 0) {
    return averaged;
  }

  const keys = Array.from(resultSets[0].keys());
  for (const key of keys) {
    const scenarioRuns = resultSets
      .map((set) => set.get(key))
      .filter((result): result is ScenarioResult => result !== undefined);

    if (scenarioRuns.length === 0) {
      continue;
    }

    averaged.set(key, {
      scenario: scenarioRuns[0].scenario,
      totalTrades: averageNumber(scenarioRuns.map((result) => result.totalTrades)),
      tradesPerHour: averageNumber(scenarioRuns.map((result) => result.tradesPerHour)),
      grossPnlSol: averageNumber(scenarioRuns.map((result) => result.grossPnlSol)),
      netPnlSol: averageNumber(scenarioRuns.map((result) => result.netPnlSol)),
      sharpe: averageNumber(scenarioRuns.map((result) => result.sharpe)),
      maxDrawdownPct: averageNumber(scenarioRuns.map((result) => result.maxDrawdownPct)),
      winRate: averageNumber(scenarioRuns.map((result) => result.winRate)),
      fillRate: averageNumber(scenarioRuns.map((result) => result.fillRate)),
      avgLatencyMs: averageNumber(scenarioRuns.map((result) => result.avgLatencyMs)),
      p95LatencyMs: averageNumber(scenarioRuns.map((result) => result.p95LatencyMs)),
      regimeBreakdown: averageRegimeBreakdown(scenarioRuns),
      bucketBreakdown: averageBucketBreakdown(scenarioRuns),
    });
  }

  return averaged;
}

function averageRegimeBreakdown(
  scenarioRuns: ScenarioResult[],
): ScenarioResult['regimeBreakdown'] {
  const averaged: ScenarioResult['regimeBreakdown'] = {
    [MarketRegime.ACCELERATING]: { trades: 0, pnl: 0, winRate: 0 },
    [MarketRegime.NORMAL]: { trades: 0, pnl: 0, winRate: 0 },
    [MarketRegime.FRAGILE]: { trades: 0, pnl: 0, winRate: 0 },
    [MarketRegime.STRESS]: { trades: 0, pnl: 0, winRate: 0 },
  };

  for (const regime of Object.values(MarketRegime)) {
    averaged[regime] = {
      trades: averageNumber(scenarioRuns.map((result) => result.regimeBreakdown[regime].trades)),
      pnl: averageNumber(scenarioRuns.map((result) => result.regimeBreakdown[regime].pnl)),
      winRate: averageNumber(scenarioRuns.map((result) => result.regimeBreakdown[regime].winRate)),
    };
  }

  return averaged;
}

function averageBucketBreakdown(
  scenarioRuns: ScenarioResult[],
): ScenarioResult['bucketBreakdown'] {
  const averaged: ScenarioResult['bucketBreakdown'] = {
    [SizingBucket.ULTRA_FAST_SNIPE]: { trades: 0, pnl: 0, avgSize: 0 },
    [SizingBucket.FAST_REACT]: { trades: 0, pnl: 0, avgSize: 0 },
    [SizingBucket.LATE_MOMENTUM]: { trades: 0, pnl: 0, avgSize: 0 },
    [SizingBucket.RECOVERY_MODE]: { trades: 0, pnl: 0, avgSize: 0 },
  };

  for (const bucket of Object.values(SizingBucket)) {
    averaged[bucket] = {
      trades: averageNumber(scenarioRuns.map((result) => result.bucketBreakdown[bucket].trades)),
      pnl: averageNumber(scenarioRuns.map((result) => result.bucketBreakdown[bucket].pnl)),
      avgSize: averageNumber(scenarioRuns.map((result) => result.bucketBreakdown[bucket].avgSize)),
    };
  }

  return averaged;
}

function averageNumber(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
