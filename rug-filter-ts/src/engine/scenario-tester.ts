/**
 * engine/scenario-tester.ts
 *
 * Comprehensive scenario testing harness that measures:
 *   - Daily trades, trade throughput
 *   - Profit per scenario, Sharpe, max drawdown
 *   - Fill rate, win rate, latency impact
 *
 * Scenarios:
 *   - Base case, noisy market, parameter sweep
 *   - Regime shift, stress market, high-throughput burst
 */

import {
  TokenSignal,
  ScenarioConfig,
  ScenarioResult,
  TradeOutcome,
  MarketRegime,
  SizingBucket,
  PipelineDecision,
} from './types';
import { TradingPipeline, PipelineConfig } from './pipeline';

// ─── Token Signal Generator ─────────────────────────────────────────

function generateRandomSignal(opts: {
  rugRate: number;
  volatilityMultiplier: number;
  slippageBase: number;
  index: number;
}): TokenSignal {
  const isRug = Math.random() < opts.rugRate;
  const mint = `token_${opts.index}_${Math.random().toString(36).substring(2, 10)}`;

  const liquiditySol = isRug
    ? 0.1 + Math.random() * 0.8
    : 0.5 + Math.random() * 15;

  const uniqueBuyers = isRug
    ? Math.floor(1 + Math.random() * 4)
    : Math.floor(3 + Math.random() * 25);

  const totalVolume = liquiditySol * (0.5 + Math.random() * 5);
  const marketCapSol = liquiditySol * (1.5 + Math.random() * 10);
  const timeSinceLaunch = Math.random() * 15;

  const logLiquidity = Math.log1p(liquiditySol);
  const logVolume = Math.log1p(totalVolume);
  const logMcap = Math.log1p(marketCapSol);

  const buyersPerSol = uniqueBuyers / Math.max(liquiditySol, 0.01);
  const volumeToLpRatio = totalVolume / Math.max(liquiditySol, 0.01);

  const slippage = opts.slippageBase + 0.15 / Math.sqrt(Math.max(liquiditySol, 0.01));
  const priceGrowth = isRug
    ? -0.1 + Math.random() * 0.3
    : Math.random() * 0.6 * opts.volatilityMultiplier;
  const socialProxy = isRug
    ? Math.random() * 0.2
    : 0.1 + Math.random() * 0.8;
  const lpGrowth = isRug
    ? -0.2 + Math.random() * 0.3
    : Math.random() * 0.5;

  const now = Date.now();
  const dt = new Date(now);

  return {
    mint,
    receivedAt: now,
    liquiditySol,
    liquidityUsd: liquiditySol * 150,
    uniqueBuyers,
    totalVolume,
    marketCapSol,
    timeSinceLaunchSec: timeSinceLaunch,
    slippageEstimate: Math.min(1, Math.max(0, slippage)),
    priceGrowth1s: Math.max(-1, Math.min(1, priceGrowth)),
    socialProxy1s: Math.max(0, Math.min(1, socialProxy)),
    lpGrowth1s: Math.max(-1, Math.min(1, lpGrowth)),
    buyersPerSol,
    volumeToLpRatio,
    logLiquidity,
    logVolume,
    logMcap,
    hourOfDay: dt.getUTCHours(),
    dayOfWeek: dt.getUTCDay(),
    isWeekend: dt.getUTCDay() >= 5,
    // Security signals
    mintEnabled: isRug && Math.random() < 0.3,
    isHoneypot: isRug && Math.random() < 0.25,
    isKnownRugDeployer: isRug && Math.random() < 0.15,
    lpLocked: isRug ? Math.random() < 0.2 : Math.random() < 0.75,
    lpBurned: !isRug && Math.random() < 0.3,
    sellTax: isRug ? Math.floor(Math.random() * 50) : Math.floor(Math.random() * 8),
    buyTax: isRug ? Math.floor(Math.random() * 20) : Math.floor(Math.random() * 5),
    ownershipRenounced: isRug ? Math.random() < 0.3 : Math.random() < 0.7,
    top10HolderPct: isRug ? 60 + Math.random() * 35 : 20 + Math.random() * 40,
    devWalletPct: isRug ? 10 + Math.random() * 30 : Math.random() * 10,
    walletClusterScore: isRug ? 0.4 + Math.random() * 0.5 : Math.random() * 0.4,
  };
}

/** Simulate trade outcome based on token characteristics */
function simulateOutcome(
  decision: PipelineDecision,
  volatilityMultiplier: number,
): TradeOutcome | null {
  if (!decision.order || !decision.risk.approved) return null;

  const signal = decision.signal;
  const isRug = signal.mintEnabled || signal.isHoneypot || signal.isKnownRugDeployer;
  const isConcentrated = signal.top10HolderPct > 70 || signal.devWalletPct > 20;

  // Simulate PnL
  let pnlPct: number;
  if (isRug) {
    pnlPct = -0.5 - Math.random() * 0.5; // -50% to -100%
  } else if (isConcentrated) {
    pnlPct = -0.3 + Math.random() * 0.6; // -30% to +30%
  } else {
    // Normal token: slight positive edge for good signals
    const edgeBase = (decision.ranked?.expectedEdge ?? 0) * 2;
    pnlPct = edgeBase + (Math.random() - 0.45) * 0.4 * volatilityMultiplier;
  }

  const sizeSol = decision.order.sizeSol;
  const pnlSol = sizeSol * pnlPct;
  const holdTimeMs = 1000 + Math.random() * 60000; // 1s to 60s

  return {
    mint: signal.mint,
    entryTimestamp: decision.decisionTimestamp,
    exitTimestamp: decision.decisionTimestamp + holdTimeMs,
    entrySizeSol: sizeSol,
    pnlSol,
    pnlPct,
    holdTimeMs,
    slippageEntry: signal.slippageEstimate * (0.5 + Math.random()),
    slippageExit: signal.slippageEstimate * (0.5 + Math.random()),
    fillQuality: 0.7 + Math.random() * 0.3,
    bucket: decision.sizing?.bucket ?? SizingBucket.FAST_REACT,
    regime: decision.regime.regime,
    mlScoreAtEntry: decision.prediction?.confidence ?? 0.5,
    expectedEdgeAtEntry: decision.ranked?.expectedEdge ?? 0,
  };
}

// ─── Pre-built Scenarios ─────────────────────────────────────────────

export const SCENARIOS: Record<string, ScenarioConfig> = {
  base_case: {
    name: 'Base Case',
    description: 'Normal market conditions with moderate rug rate',
    durationMs: 300_000, // 5 min
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
    durationMs: 120_000, // 2 min
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

// ─── Scenario Runner ─────────────────────────────────────────────────

export class ScenarioTester {
  private pipeline: TradingPipeline;

  constructor(pipelineConfig?: Partial<PipelineConfig>) {
    this.pipeline = new TradingPipeline({
      ...pipelineConfig,
      executionRouter: {
        liveExecution: false,
        baseLatencyMs: 50,
        ...pipelineConfig?.executionRouter,
      },
    });
  }

  /**
   * Run a single scenario and return results.
   */
  async runScenario(scenario: ScenarioConfig): Promise<ScenarioResult> {
    // Reset pipeline state
    this.pipeline = new TradingPipeline({
      executionRouter: { liveExecution: false, baseLatencyMs: 50 },
    });

    const startTime = Date.now();
    const decisions: PipelineDecision[] = [];
    const outcomes: TradeOutcome[] = [];

    // Generate tokens
    const signals: TokenSignal[] = [];
    for (let i = 0; i < scenario.tokenCount; i++) {
      signals.push(
        generateRandomSignal({
          rugRate: scenario.rugRate,
          volatilityMultiplier: scenario.volatilityMultiplier,
          slippageBase: scenario.slippageBase,
          index: i,
        }),
      );
    }

    // Process signals
    let processed = 0;
    const total = signals.length;
    const progressInterval = Math.max(1, Math.floor(total / 10));

    for (const signal of signals) {
      const decision = await this.pipeline.processSignal(signal);
      decisions.push(decision);

      // Simulate outcome for executed trades
      if (decision.order && decision.risk.approved) {
        const outcome = simulateOutcome(decision, scenario.volatilityMultiplier);
        if (outcome) {
          outcomes.push(outcome);
          this.pipeline.recordTradeExit(outcome);
        }
      }

      processed++;
      if (processed % progressInterval === 0 || processed === total) {
        process.stdout.write(`\r    Progress: ${processed}/${total} signals (${Math.round((processed/total)*100)}%)`);
      }
    }
    console.log('');

    const elapsed = Date.now() - startTime;
    return this.computeResult(scenario, decisions, outcomes, elapsed);
  }

  /**
   * Run all pre-built scenarios and return results.
   */
  async runAllScenarios(): Promise<Map<string, ScenarioResult>> {
    const results = new Map<string, ScenarioResult>();

    for (const [key, scenario] of Object.entries(SCENARIOS)) {
      const result = await this.runScenario(scenario);
      results.set(key, result);
    }

    return results;
  }

  /**
   * Format results as a human-readable report string.
   */
  static formatReport(results: Map<string, ScenarioResult>): string {
    const lines: string[] = [
      '═══════════════════════════════════════════════════════════════════',
      '  MEMECOIN SNIPER — SCENARIO TEST REPORT',
      `  Generated: ${new Date().toISOString()}`,
      '═══════════════════════════════════════════════════════════════════',
      '',
    ];

    for (const [key, result] of results) {
      lines.push(`┌─ ${result.scenario} (${key})`);
      lines.push(`│  Tokens: ${result.totalTrades > 0 ? 'Yes' : 'No trades'}`);
      lines.push(`│  Total Trades:      ${result.totalTrades}`);
      lines.push(`│  Trades/Hour:       ${result.tradesPerHour.toFixed(1)}`);
      lines.push(`│  Gross PnL:         ${result.grossPnlSol >= 0 ? '+' : ''}${result.grossPnlSol.toFixed(4)} SOL`);
      lines.push(`│  Net PnL:           ${result.netPnlSol >= 0 ? '+' : ''}${result.netPnlSol.toFixed(4)} SOL`);
      lines.push(`│  Sharpe:            ${result.sharpe.toFixed(3)}`);
      lines.push(`│  Max Drawdown:      ${result.maxDrawdownPct.toFixed(2)}%`);
      lines.push(`│  Win Rate:          ${(result.winRate * 100).toFixed(1)}%`);
      lines.push(`│  Fill Rate:         ${(result.fillRate * 100).toFixed(1)}%`);
      lines.push(`│  Avg Latency:       ${result.avgLatencyMs.toFixed(1)}ms`);
      lines.push(`│  P95 Latency:       ${result.p95LatencyMs.toFixed(1)}ms`);

      // Regime breakdown
      lines.push(`│  ── Regime Breakdown ──`);
      for (const [regime, data] of Object.entries(result.regimeBreakdown)) {
        if (data.trades > 0) {
          lines.push(`│    ${regime}: ${data.trades} trades, PnL ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(4)}, WR ${(data.winRate * 100).toFixed(0)}%`);
        }
      }

      // Bucket breakdown
      lines.push(`│  ── Bucket Breakdown ──`);
      for (const [bucket, data] of Object.entries(result.bucketBreakdown)) {
        if (data.trades > 0) {
          lines.push(`│    ${bucket}: ${data.trades} trades, PnL ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(4)}, avg size ${data.avgSize.toFixed(4)}`);
        }
      }

      lines.push(`└──────────────────────────────────────────────`);
      lines.push('');
    }

    // Summary
    const allResults = Array.from(results.values());
    const totalTrades = allResults.reduce((s, r) => s + r.totalTrades, 0);
    const totalPnl = allResults.reduce((s, r) => s + r.netPnlSol, 0);
    const avgSharpe = allResults.reduce((s, r) => s + r.sharpe, 0) / Math.max(allResults.length, 1);
    const avgWinRate = allResults.reduce((s, r) => s + r.winRate, 0) / Math.max(allResults.length, 1);

    lines.push('═══════════════════════════════════════════════════════════════════');
    lines.push('  AGGREGATE SUMMARY');
    lines.push(`  Total Scenarios:     ${allResults.length}`);
    lines.push(`  Total Trades:        ${totalTrades}`);
    lines.push(`  Total Net PnL:       ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL`);
    lines.push(`  Avg Sharpe:          ${avgSharpe.toFixed(3)}`);
    lines.push(`  Avg Win Rate:        ${(avgWinRate * 100).toFixed(1)}%`);
    lines.push('═══════════════════════════════════════════════════════════════════');

    return lines.join('\n');
  }

  // ── Private ────────────────────────────────────────────────────────

  private computeResult(
    scenario: ScenarioConfig,
    decisions: PipelineDecision[],
    outcomes: TradeOutcome[],
    elapsedMs: number,
  ): ScenarioResult {
    const totalTrades = outcomes.length;
    const elapsedHours = Math.max(elapsedMs / (1000 * 60 * 60), 0.001);

    const wins = outcomes.filter((o) => o.pnlSol > 0);
    const grossPnl = outcomes.reduce((s, o) => s + Math.max(0, o.pnlSol), 0);
    const losses = outcomes.reduce((s, o) => s + Math.min(0, o.pnlSol), 0);
    const netPnl = grossPnl + losses;

    // Sharpe
    const returns = outcomes.map((o) => o.pnlPct);
    let sharpe = 0;
    if (returns.length > 2) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
      const std = Math.sqrt(variance);
      sharpe = std > 1e-10 ? (mean / std) * Math.sqrt(252) : 0;
    }

    // Max drawdown
    let maxDDPct = 0;
    let equity = 10; // assume 10 SOL initial
    let peak = equity;
    for (const o of outcomes) {
      equity += o.pnlSol;
      peak = Math.max(peak, equity);
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      maxDDPct = Math.max(maxDDPct, dd);
    }

    // Fill rate
    const executionAttempts = decisions.filter((d) => d.order !== null).length;
    const fills = decisions.filter(
      (d) => d.order !== null && d.risk.approved,
    ).length;
    const fillRate = executionAttempts > 0 ? fills / executionAttempts : 0;

    // Latencies
    const latencies = decisions.map((d) => d.totalLatencyMs);
    const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const sortedLat = [...latencies].sort((a, b) => a - b);
    const p95Latency = sortedLat.length > 0 ? sortedLat[Math.floor(sortedLat.length * 0.95)] : 0;

    // Regime breakdown
    const regimeBreakdown: Record<MarketRegime, { trades: number; pnl: number; winRate: number }> = {
      [MarketRegime.ACCELERATING]: { trades: 0, pnl: 0, winRate: 0 },
      [MarketRegime.NORMAL]: { trades: 0, pnl: 0, winRate: 0 },
      [MarketRegime.FRAGILE]: { trades: 0, pnl: 0, winRate: 0 },
      [MarketRegime.STRESS]: { trades: 0, pnl: 0, winRate: 0 },
    };
    for (const o of outcomes) {
      const r = regimeBreakdown[o.regime];
      r.trades++;
      r.pnl += o.pnlSol;
    }
    for (const r of Object.values(regimeBreakdown)) {
      if (r.trades > 0) {
        const regimeOutcomes = outcomes.filter((o) => regimeBreakdown[o.regime] === r);
        const regimeWins = regimeOutcomes.filter((o) => o.pnlSol > 0).length;
        r.winRate = regimeWins / r.trades;
      }
    }

    // Bucket breakdown
    const bucketBreakdown: Record<SizingBucket, { trades: number; pnl: number; avgSize: number }> = {
      [SizingBucket.ULTRA_FAST_SNIPE]: { trades: 0, pnl: 0, avgSize: 0 },
      [SizingBucket.FAST_REACT]: { trades: 0, pnl: 0, avgSize: 0 },
      [SizingBucket.LATE_MOMENTUM]: { trades: 0, pnl: 0, avgSize: 0 },
      [SizingBucket.RECOVERY_MODE]: { trades: 0, pnl: 0, avgSize: 0 },
    };
    for (const o of outcomes) {
      const b = bucketBreakdown[o.bucket];
      b.trades++;
      b.pnl += o.pnlSol;
      b.avgSize += o.entrySizeSol;
    }
    for (const b of Object.values(bucketBreakdown)) {
      if (b.trades > 0) b.avgSize /= b.trades;
    }

    return {
      scenario: scenario.name,
      totalTrades,
      tradesPerHour: totalTrades / elapsedHours,
      grossPnlSol: grossPnl,
      netPnlSol: netPnl,
      sharpe,
      maxDrawdownPct: maxDDPct,
      winRate: totalTrades > 0 ? wins.length / totalTrades : 0,
      fillRate,
      avgLatencyMs: avgLatency,
      p95LatencyMs: p95Latency,
      regimeBreakdown,
      bucketBreakdown,
    };
  }
}
