/**
 * engine/scenario_tester.ts
 *
 * Realistic scenario testing harness for the memecoin backtester.
 * Keeps the existing scenario buckets and regime reporting intact while
 * introducing latent rugs, execution friction, MEV rejection, and lag spikes.
 */

import {
  MarketRegime,
  PipelineDecision,
  ScenarioConfig,
  ScenarioResult,
  SizingBucket,
  TradeOutcome,
} from './types';
import { TradingPipeline, PipelineConfig } from './pipeline';
import {
  DEFAULT_SCENARIO_REALISM,
  generateScenarioSignal,
  ScenarioSignalContext,
  simulateScenarioOutcome,
} from './signal_generator';

export const SCENARIOS: Record<string, ScenarioConfig> = {
  base_case: {
    name: 'Base Case',
    description: 'Normal market conditions with moderate rug rate',
    durationMs: 300_000,
    tokenCount: 100,
    rugRate: 0.15,
    volatilityMultiplier: 1.0,
    launchRatePerMin: 20,
    slippageBase: 0.02,
    regimeSchedule: [{ atMs: 0, regime: MarketRegime.NORMAL }],
  },
  noisy_market: {
    name: 'Noisy Market',
    description: 'High noise: frequent rugs, high volatility, poor signals',
    durationMs: 300_000,
    tokenCount: 120,
    rugRate: 0.35,
    volatilityMultiplier: 2.0,
    launchRatePerMin: 24,
    slippageBase: 0.04,
    regimeSchedule: [{ atMs: 0, regime: MarketRegime.NORMAL }],
  },
  regime_shift: {
    name: 'Regime Shift',
    description: 'Market transitions through all four regimes',
    durationMs: 300_000,
    tokenCount: 100,
    rugRate: 0.2,
    volatilityMultiplier: 1.5,
    launchRatePerMin: 20,
    slippageBase: 0.03,
    regimeSchedule: [
      { atMs: 0, regime: MarketRegime.ACCELERATING },
      { atMs: 75_000, regime: MarketRegime.NORMAL },
      { atMs: 150_000, regime: MarketRegime.FRAGILE },
      { atMs: 225_000, regime: MarketRegime.STRESS },
    ],
  },
  stress_market: {
    name: 'Stress Market',
    description: 'Sustained stress conditions: high rug rate, bad fills, high slippage',
    durationMs: 300_000,
    tokenCount: 80,
    rugRate: 0.4,
    volatilityMultiplier: 2.5,
    launchRatePerMin: 16,
    slippageBase: 0.06,
    regimeSchedule: [{ atMs: 0, regime: MarketRegime.STRESS }],
  },
  high_throughput_burst: {
    name: 'High-Throughput Burst',
    description: 'Massive token launch rate: tests pipeline throughput limits',
    durationMs: 120_000,
    tokenCount: 400,
    rugRate: 0.12,
    volatilityMultiplier: 1.2,
    launchRatePerMin: 200,
    slippageBase: 0.02,
    regimeSchedule: [{ atMs: 0, regime: MarketRegime.ACCELERATING }],
  },
  parameter_sweep: {
    name: 'Parameter Sweep',
    description: 'Mixed conditions for parameter sensitivity testing',
    durationMs: 300_000,
    tokenCount: 150,
    rugRate: 0.25,
    volatilityMultiplier: 1.8,
    launchRatePerMin: 30,
    slippageBase: 0.035,
    regimeSchedule: [
      { atMs: 0, regime: MarketRegime.NORMAL },
      { atMs: 100_000, regime: MarketRegime.ACCELERATING },
      { atMs: 200_000, regime: MarketRegime.FRAGILE },
    ],
  },
};

export class ScenarioTester {
  private readonly startingEquitySol = 0.15;
  private pipeline: TradingPipeline;
  private readonly pipelineConfig?: Partial<PipelineConfig>;

  constructor(pipelineConfig?: Partial<PipelineConfig>) {
    this.pipelineConfig = pipelineConfig;
    this.pipeline = this.createPipeline({
      name: 'Warm Start',
      description: '',
      durationMs: 60_000,
      tokenCount: 1,
      rugRate: 0.15,
      volatilityMultiplier: 1,
      launchRatePerMin: 1,
      slippageBase: 0.02,
      regimeSchedule: [{ atMs: 0, regime: MarketRegime.NORMAL }],
    });
  }

  async runScenario(scenario: ScenarioConfig): Promise<ScenarioResult> {
    this.pipeline = this.createPipeline(scenario);

    const decisions: PipelineDecision[] = [];
    const outcomes: TradeOutcome[] = [];
    const contexts = Array.from({ length: scenario.tokenCount }, (_, index) =>
      generateScenarioSignal(scenario, index, DEFAULT_SCENARIO_REALISM),
    ).sort((a, b) => a.relativeTimeMs - b.relativeTimeMs);

    let processed = 0;
    const progressInterval = Math.max(1, Math.floor(contexts.length / 10));

    for (const context of contexts) {
      this.pipeline.regimeDetector.setForcedRegime(context.scheduledRegime);
      this.pipeline.regimeDetector.recordLaunchQuality(this.computeLaunchQuality(context));

      const decision = await this.pipeline.processSignal(context.signal);
      decisions.push(decision);

      if (decision.execution?.filled) {
        const outcome = simulateScenarioOutcome({
          decision,
          execution: decision.execution,
          context,
          assumptions: DEFAULT_SCENARIO_REALISM,
        });
        outcomes.push(outcome);
        this.pipeline.recordTradeExit(outcome);
      }

      processed++;
      if (processed % progressInterval === 0 || processed === contexts.length) {
        process.stdout.write(
          `\r    Progress: ${processed}/${contexts.length} signals (${Math.round((processed / contexts.length) * 100)}%)`,
        );
      }
    }

    this.pipeline.regimeDetector.setForcedRegime(null);
    console.log('');

    return this.computeResult(scenario, decisions, outcomes);
  }

  async runAllScenarios(): Promise<Map<string, ScenarioResult>> {
    const results = new Map<string, ScenarioResult>();

    for (const [key, scenario] of Object.entries(SCENARIOS)) {
      const result = await this.runScenario(scenario);
      results.set(key, result);
    }

    return results;
  }

  static formatReport(results: Map<string, ScenarioResult>): string {
    const lines: string[] = [
      '===================================================================',
      '  MEMECOIN SNIPER - SCENARIO TEST REPORT',
      `  Generated: ${new Date().toISOString()}`,
      '===================================================================',
      '',
    ];

    for (const [key, result] of results) {
      lines.push(`+- ${result.scenario} (${key})`);
      lines.push(`|  Tokens:            ${result.totalTrades > 0 ? 'Yes' : 'No trades'}`);
      lines.push(`|  Total Trades:      ${result.totalTrades}`);
      lines.push(`|  Trades/Hour:       ${result.tradesPerHour.toFixed(1)}`);
      lines.push(`|  Gross PnL:         ${formatSigned(result.grossPnlSol)} SOL`);
      lines.push(`|  Net PnL:           ${formatSigned(result.netPnlSol)} SOL`);
      lines.push(`|  Sharpe:            ${result.sharpe.toFixed(3)}`);
      lines.push(`|  Max Drawdown:      ${result.maxDrawdownPct.toFixed(2)}%`);
      lines.push(`|  Win Rate:          ${(result.winRate * 100).toFixed(1)}%`);
      lines.push(`|  Fill Rate:         ${(result.fillRate * 100).toFixed(1)}%`);
      lines.push(`|  Avg Latency:       ${result.avgLatencyMs.toFixed(1)}ms`);
      lines.push(`|  P95 Latency:       ${result.p95LatencyMs.toFixed(1)}ms`);
      lines.push(`|  -- Regime Breakdown --`);

      for (const [regime, data] of Object.entries(result.regimeBreakdown)) {
        if (data.trades > 0) {
          lines.push(
            `|    ${regime}: ${data.trades} trades, PnL ${formatSigned(data.pnl)}, WR ${(data.winRate * 100).toFixed(0)}%`,
          );
        }
      }

      lines.push(`|  -- Bucket Breakdown --`);
      for (const [bucket, data] of Object.entries(result.bucketBreakdown)) {
        if (data.trades > 0) {
          lines.push(
            `|    ${bucket}: ${data.trades} trades, PnL ${formatSigned(data.pnl)}, avg size ${data.avgSize.toFixed(4)}`,
          );
        }
      }

      lines.push('+------------------------------------------------');
      lines.push('');
    }

    const allResults = Array.from(results.values());
    const totalTrades = allResults.reduce((sum, result) => sum + result.totalTrades, 0);
    const totalPnl = allResults.reduce((sum, result) => sum + result.netPnlSol, 0);
    const tradeWeight = Math.max(totalTrades, 1);
    const weightedSharpe =
      allResults.reduce((sum, result) => sum + result.sharpe * result.totalTrades, 0) / tradeWeight;
    const weightedWinRate =
      allResults.reduce((sum, result) => sum + result.winRate * result.totalTrades, 0) / tradeWeight;
    const weightedMaxDrawdown =
      allResults.reduce((sum, result) => sum + result.maxDrawdownPct * result.totalTrades, 0) / tradeWeight;

    lines.push('===================================================================');
    lines.push('  AGGREGATE SUMMARY');
    lines.push(`  Total Scenarios:     ${allResults.length}`);
    lines.push(`  Total Trades:        ${totalTrades}`);
    lines.push(`  Total Net PnL:       ${formatSigned(totalPnl)} SOL`);
    lines.push(`  Trade-Weighted Sharpe: ${weightedSharpe.toFixed(3)}`);
    lines.push(`  Trade-Weighted Max DD: ${weightedMaxDrawdown.toFixed(2)}%`);
    lines.push(`  Trade-Weighted WR:     ${(weightedWinRate * 100).toFixed(1)}%`);
    lines.push('===================================================================');

    return lines.join('\n');
  }

  private createPipeline(scenario: ScenarioConfig): TradingPipeline {
    return new TradingPipeline({
      ...this.pipelineConfig,
      maxSlippagePct: 0.18,
      orderDeadlineMs: 4_000,
      verbose: false,
      dynamicSizer: {
        basePositionPct: 80,
        maxPositionPct: 100,
        maxPositionSol: 0.45,
        topDecileMultiplier: 1.2,
        ...(this.pipelineConfig?.dynamicSizer ?? {}),
      },
      riskManager: {
        initialBankrollSol: this.startingEquitySol,
        maxRiskPerTradePct: 66.0,
        maxPositionSol: 0.45,
        dailyDrawdownLimitPct: 40,
        rollingDrawdownLimitPct: 45,
        maxConcurrentTrades: 120,
        ...(this.pipelineConfig?.riskManager ?? {}),
      },
      executionRouter: {
        liveExecution: false,
        baseLatencyMs: scenario.regimeSchedule.some((step) => step.regime === MarketRegime.STRESS) ? 95 : 80,
        baseSlippagePct: Math.max(0.02, scenario.slippageBase),
        simulatedFailRate: DEFAULT_SCENARIO_REALISM.mevRejectRate,
        ...(this.pipelineConfig?.executionRouter ?? {}),
      },
    });
  }

  private computeResult(
    scenario: ScenarioConfig,
    decisions: PipelineDecision[],
    outcomes: TradeOutcome[],
  ): ScenarioResult {
    const totalTrades = outcomes.length;
    const wins = outcomes.filter((outcome) => outcome.pnlSol > 0);
    const grossPnl = outcomes.reduce((sum, outcome) => sum + Math.max(outcome.pnlSol, 0), 0);
    const netPnl = outcomes.reduce((sum, outcome) => sum + outcome.pnlSol, 0);
    const elapsedHours = Math.max(scenario.durationMs / (1000 * 60 * 60), 1 / 60);

    let equity = this.startingEquitySol;
    let peak = equity;
    let maxDrawdownPct = 0;
    const equityReturns: number[] = [];

    for (const outcome of outcomes) {
      const tradeReturn = equity > 0 ? outcome.pnlSol / equity : 0;
      equityReturns.push(tradeReturn);
      equity += outcome.pnlSol;
      peak = Math.max(peak, equity);
      const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
    }

    // Closed-trade equity underestimates drawdown when many positions overlap in time.
    // Scale DD by scenario hold-time coverage to reflect stacked open-risk during bursts.
    const holdCoverage =
      outcomes.reduce((sum, outcome) => sum + outcome.holdTimeMs, 0) /
      Math.max(scenario.durationMs, 1);
    const overlapFactor = clamp(1 + Math.log1p(holdCoverage) * 0.22, 1, 1.6);
    maxDrawdownPct *= overlapFactor;

    let sharpe = 0;
    if (equityReturns.length > 2) {
      const mean = equityReturns.reduce((sum, value) => sum + value, 0) / equityReturns.length;
      const variance =
        equityReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / equityReturns.length;
      const std = Math.sqrt(variance);
      sharpe = std > 1e-10 ? (mean / std) * Math.sqrt(equityReturns.length) : 0;
    }

    const executionAttempts = decisions.filter((decision) => decision.order !== null).length;
    const fills = decisions.filter((decision) => decision.execution?.filled).length;
    const fillRate = executionAttempts > 0 ? fills / executionAttempts : 0;

    const latencies = decisions
      .map((decision) => decision.execution?.latencyMs)
      .filter((latency): latency is number => typeof latency === 'number');
    const avgLatency =
      latencies.length > 0
        ? latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length
        : 0;
    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    const p95Latency =
      sortedLatencies.length > 0
        ? sortedLatencies[Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * 0.95))]
        : 0;

    const regimeBreakdown: Record<
      MarketRegime,
      { trades: number; pnl: number; winRate: number }
    > = {
      [MarketRegime.ACCELERATING]: { trades: 0, pnl: 0, winRate: 0 },
      [MarketRegime.NORMAL]: { trades: 0, pnl: 0, winRate: 0 },
      [MarketRegime.FRAGILE]: { trades: 0, pnl: 0, winRate: 0 },
      [MarketRegime.STRESS]: { trades: 0, pnl: 0, winRate: 0 },
    };
    const bucketBreakdown: Record<
      SizingBucket,
      { trades: number; pnl: number; avgSize: number }
    > = {
      [SizingBucket.ULTRA_FAST_SNIPE]: { trades: 0, pnl: 0, avgSize: 0 },
      [SizingBucket.FAST_REACT]: { trades: 0, pnl: 0, avgSize: 0 },
      [SizingBucket.LATE_MOMENTUM]: { trades: 0, pnl: 0, avgSize: 0 },
      [SizingBucket.RECOVERY_MODE]: { trades: 0, pnl: 0, avgSize: 0 },
    };

    for (const outcome of outcomes) {
      regimeBreakdown[outcome.regime].trades++;
      regimeBreakdown[outcome.regime].pnl += outcome.pnlSol;
      bucketBreakdown[outcome.bucket].trades++;
      bucketBreakdown[outcome.bucket].pnl += outcome.pnlSol;
      bucketBreakdown[outcome.bucket].avgSize += outcome.entrySizeSol;
    }

    for (const regime of Object.values(MarketRegime)) {
      const trades = outcomes.filter((outcome) => outcome.regime === regime);
      if (trades.length > 0) {
        regimeBreakdown[regime].winRate = trades.filter((outcome) => outcome.pnlSol > 0).length / trades.length;
      }
    }

    for (const bucket of Object.values(SizingBucket)) {
      const trades = bucketBreakdown[bucket].trades;
      if (trades > 0) {
        bucketBreakdown[bucket].avgSize /= trades;
      }
    }

    return {
      scenario: scenario.name,
      totalTrades,
      tradesPerHour: totalTrades / elapsedHours,
      grossPnlSol: grossPnl,
      netPnlSol: netPnl,
      sharpe,
      maxDrawdownPct,
      winRate: totalTrades > 0 ? wins.length / totalTrades : 0,
      fillRate,
      avgLatencyMs: avgLatency,
      p95LatencyMs: p95Latency,
      regimeBreakdown,
      bucketBreakdown,
    };
  }

  private computeLaunchQuality(context: ScenarioSignalContext): number {
    return clamp(
      0.55 +
        context.qualityBias +
        context.signal.socialProxy1s * 0.2 -
        context.signal.walletClusterScore * 0.3 -
        context.signal.slippageEstimate * 0.5,
      0,
      1,
    );
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}
