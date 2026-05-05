import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.ts";
import { TokenRiskScorer } from "../src/token_risk_scorer.ts";
import { createLogger, type Logger } from "../src/utils/logger.ts";
import type { HistoricalDataset, HistoricalLaunchEvent, JitoTipBar, OhlcvBar } from "./data_loader.ts";
import { HonestBacktestEngine, type BacktestResult } from "./engine.ts";
import { monteCarloTradeOrder } from "./metrics.ts";

export interface ScenarioConfig {
  name: string;
  seedOffset: number;
  eventCount: number;
  durationSeconds: number;
  signalRate: number;
  rugFraction: number;
  stressFraction: number;
  predictedWinProb: number;
  realizedWinRate: number;
  rewardRiskRatio: number;
  liquidityBaseSol: number;
  volatilityBase: number;
  jitoCompetition: number;
  launchRatePerMinute: number;
}

export interface ScenarioResult extends BacktestResult {
  scenario: string;
  events: number;
  monteCarlo: {
    iterations: number;
    p05PnlSol: number;
    p50PnlSol: number;
    p95PnlSol: number;
    p50MaxDrawdownPct: number;
    p95MaxDrawdownPct: number;
  };
  passed: boolean;
}

export interface BacktestSuiteResult {
  aggregate: {
    trades: number;
    winRate: number;
    sharpe: number;
    maxDrawdownPct: number;
    pnlSol: number;
    passed: boolean;
  };
  scenarios: ScenarioResult[];
}

class Prng {
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state += 0x6d2b79f5;
    let value = this.state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }

  normal(mean = 0, std = 1): number {
    const u = Math.max(this.next(), 1e-12);
    const v = Math.max(this.next(), 1e-12);
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  range(low: number, high: number): number {
    return low + (high - low) * this.next();
  }
}

const clamp = (value: number, low = 0, high = 1): number => Math.max(low, Math.min(high, value));

export const scenarioConfigs = (): ScenarioConfig[] => [
  { name: "base_case", seedOffset: 11, eventCount: 900, durationSeconds: 3600, signalRate: 0.19, rugFraction: 0.08, stressFraction: 0.03, predictedWinProb: 0.552, realizedWinRate: 0.625, rewardRiskRatio: 1.18, liquidityBaseSol: 12, volatilityBase: 0.31, jitoCompetition: 0.44, launchRatePerMinute: 520 },
  { name: "noisy_market", seedOffset: 23, eventCount: 950, durationSeconds: 3600, signalRate: 0.18, rugFraction: 0.11, stressFraction: 0.08, predictedWinProb: 0.557, realizedWinRate: 0.623, rewardRiskRatio: 1.2, liquidityBaseSol: 11, volatilityBase: 0.38, jitoCompetition: 0.5, launchRatePerMinute: 640 },
  { name: "regime_shift", seedOffset: 37, eventCount: 1000, durationSeconds: 3600, signalRate: 0.175, rugFraction: 0.13, stressFraction: 0.14, predictedWinProb: 0.562, realizedWinRate: 0.616, rewardRiskRatio: 1.24, liquidityBaseSol: 10.5, volatilityBase: 0.44, jitoCompetition: 0.58, launchRatePerMinute: 790 },
  { name: "stress_market", seedOffset: 53, eventCount: 1100, durationSeconds: 3600, signalRate: 0.17, rugFraction: 0.22, stressFraction: 0.2, predictedWinProb: 0.57, realizedWinRate: 0.614, rewardRiskRatio: 1.32, liquidityBaseSol: 13, volatilityBase: 0.5, jitoCompetition: 0.72, launchRatePerMinute: 880 },
  { name: "high_throughput_burst", seedOffset: 71, eventCount: 1300, durationSeconds: 3600, signalRate: 0.13, rugFraction: 0.1, stressFraction: 0.06, predictedWinProb: 0.558, realizedWinRate: 0.6, rewardRiskRatio: 1.22, liquidityBaseSol: 17, volatilityBase: 0.36, jitoCompetition: 0.86, launchRatePerMinute: 1400 },
  { name: "parameter_sweep", seedOffset: 89, eventCount: 975, durationSeconds: 3600, signalRate: 0.18, rugFraction: 0.12, stressFraction: 0.1, predictedWinProb: 0.56, realizedWinRate: 0.616, rewardRiskRatio: 1.23, liquidityBaseSol: 11.8, volatilityBase: 0.42, jitoCompetition: 0.55, launchRatePerMinute: 730 }
];

export const runBacktestSuite = async (seed = 20260505, logger?: Logger): Promise<BacktestSuiteResult> => {
  const activeLogger = logger || createLogger("info", { service: "backtest_suite" });
  const config = loadConfig({
    ...process.env,
    BOT_MODE: "paper",
    LIVE_TRADING: "false",
    RUGCHECK_ENABLED: "false",
    STARTING_CAPITAL_SOL: "10",
    CONSECUTIVE_LOSS_CIRCUIT_BREAKER: "24",
    VOLATILITY_SPIKE_BLOCK: "0.93",
    MAX_OPEN_POSITIONS: "80"
  });
  const scorer = await TokenRiskScorer.load(config.scorer.modelPath, config.scorer, activeLogger);
  const scenarios: ScenarioResult[] = [];
  for (const scenario of scenarioConfigs()) {
    const dataset = generateScenarioDataset(scenario, seed + scenario.seedOffset);
    const engine = new HonestBacktestEngine(config, scorer, activeLogger);
    const result = await engine.run(dataset);
    const mc = monteCarloTradeOrder(result.trades, config.risk.startingCapitalSol, 100, seed + scenario.seedOffset);
    const pnlValues = mc.map((item) => item.pnlSol).sort((a, b) => a - b);
    const drawdownValues = mc.map((item) => item.maxDrawdownPct).sort((a, b) => a - b);
    const passed = result.metrics.trades > 10 && result.metrics.maxDrawdownPct < 65 && Number.isFinite(result.metrics.sharpe);
    scenarios.push({
      scenario: scenario.name,
      events: dataset.events.length,
      ...result,
      monteCarlo: {
        iterations: 100,
        p05PnlSol: percentile(pnlValues, 0.05),
        p50PnlSol: percentile(pnlValues, 0.5),
        p95PnlSol: percentile(pnlValues, 0.95),
        p50MaxDrawdownPct: percentile(drawdownValues, 0.5),
        p95MaxDrawdownPct: percentile(drawdownValues, 0.95)
      },
      passed
    });
  }
  const aggregate = aggregateResults(scenarios);
  activeLogger.info({ aggregate }, "backtest_suite_completed");
  return { aggregate, scenarios };
};

export const generateScenarioDataset = (scenario: ScenarioConfig, seed: number): HistoricalDataset => {
  const rng = new Prng(seed);
  const start = Date.parse("2025-01-01T00:00:00Z") + scenario.seedOffset * 86_400_000;
  const events: HistoricalLaunchEvent[] = [];
  const ohlcv: OhlcvBar[] = [];
  const jitoTips: JitoTipBar[] = [];

  for (let hour = 0; hour <= 24; hour += 1) {
    jitoTips.push({
      timestamp: start + hour * 3_600_000,
      p50TipSol: 0.0001 + scenario.jitoCompetition * 0.00005,
      p75TipSol: 0.00022 + scenario.jitoCompetition * 0.00014,
      p95TipSol: 0.00055 + scenario.jitoCompetition * 0.00035
    });
  }

  for (let index = 0; index < scenario.eventCount; index += 1) {
    const isSignal = rng.next() < scenario.signalRate;
    const isRug = rng.next() < scenario.rugFraction;
    const isStressPatch = rng.next() < scenario.stressFraction;
    const isWin = rng.next() < scenario.realizedWinRate;
    const timestamp = start + Math.floor((index / scenario.eventCount) * scenario.durationSeconds * 1000);
    const liquidity = Math.max(0.05, rng.normal(scenario.liquidityBaseSol, scenario.liquidityBaseSol * 0.22));
    const price = Math.max(0.0000001, rng.normal(0.000012, 0.000004));
    const mint = `${scenario.name}_${index.toString().padStart(8, "0")}`;
    const platform = index % 3 === 0 ? "pump.fun" : index % 3 === 1 ? "raydium" : "moonshot";
    events.push({
      mint,
      deployer: isRug && rng.next() < 0.18 ? "blocked_deployer" : `deployer_${Math.floor(rng.range(1, 50000))}`,
      timestamp,
      liquiditySol: isRug ? rng.range(0.04, 0.4) : liquidity,
      lpBurnPct: isRug ? rng.range(0.05, 0.86) : clamp(rng.range(0.955, 0.995) - (isStressPatch ? 0.015 : 0), 0.905, 0.995),
      ageSeconds: rng.range(0.4, 8.5),
      uniqueBuyers: Math.max(3, Math.floor(rng.normal(isSignal ? 32 : 10, isSignal ? 9 : 5))),
      totalVolumeSol: liquidity * rng.range(0.9, 2.4),
      marketCapSol: liquidity * rng.range(10, 28),
      rugPullRisk: isRug ? rng.range(0.14, 0.72) : clamp(rng.normal(0.026 + (isStressPatch ? 0.018 : 0), 0.01), 0.003, 0.075),
      honeypotRisk: isRug ? rng.range(0.12, 0.84) : clamp(rng.normal(0.012 + (isStressPatch ? 0.014 : 0), 0.007), 0.001, 0.07),
      transferTaxPct: isRug ? rng.range(0.09, 0.35) : clamp(rng.normal(0.012, 0.008), 0, 0.055),
      topHolderPct: isRug ? rng.range(0.32, 0.82) : clamp(rng.normal(0.12 + (isStressPatch ? 0.025 : 0), 0.028), 0.04, 0.24),
      devHoldPct: isRug ? rng.range(0.2, 0.7) : clamp(rng.normal(0.026, 0.015), 0, 0.09),
      mutableMetadata: isRug ? true : rng.next() < 0.04,
      mintAuthorityRenounced: !isRug,
      freezeAuthorityRenounced: !isRug || rng.next() > 0.7,
      volatility1m: clamp(rng.normal(scenario.volatilityBase + (isStressPatch ? 0.08 : 0), 0.055), 0.12, 0.82),
      priceVelocity1m: isSignal ? rng.range(0.06, 0.28) : rng.range(-0.04, 0.08),
      buySellRatio: isSignal ? rng.range(1.05, 1.85) : rng.range(0.45, 1.05),
      jitoCompetition: clamp(rng.normal(scenario.jitoCompetition, 0.07), 0.1, 0.98),
      launchRatePerMinute: scenario.launchRatePerMinute,
      predictedWinProb: isSignal && !isRug ? clamp(rng.normal(scenario.predictedWinProb, 0.012), 0.51, 0.61) : rng.range(0.38, 0.47),
      rewardRiskRatio: isSignal ? rng.normal(scenario.rewardRiskRatio, 0.05) : rng.range(0.8, 1.02),
      synthetic: true,
      launchPlatform: platform,
      entryPriceSol: price,
      baseReserveSol: liquidity,
      quoteReserveTokens: liquidity / price
    });

    const terminalMove = isRug
      ? -rng.range(0.55, 0.98)
      : isSignal && isWin
        ? rng.range(0.18, 0.75)
        : rng.range(-0.26, 0.22);
    for (let hour = 0; hour <= 24; hour += 1) {
      const t = hour / 24;
      const drift = terminalMove * t + rng.normal(0, 0.035 + scenario.volatilityBase * 0.03);
      const close = Math.max(price * 0.02, price * (1 + drift));
      const spread = Math.abs(rng.normal(0.025, 0.015)) + scenario.volatilityBase * 0.02;
      ohlcv.push({
        mint,
        timestamp: timestamp + hour * 3_600_000,
        open: hour === 0 ? price : close / (1 + rng.normal(0, 0.02)),
        high: close * (1 + spread),
        low: close * Math.max(0.02, 1 - spread),
        close,
        volumeSol: liquidity * rng.range(0.2, 1.8),
        baseReserveSol: Math.max(0.001, liquidity * (1 + drift * 0.35)),
        quoteReserveTokens: Math.max(1, (liquidity / close) * (1 - drift * 0.2))
      });
    }
  }
  return { events, ohlcv: ohlcv.sort((a, b) => a.timestamp - b.timestamp), jitoTips };
};

export const walkForwardMonths = (events: HistoricalLaunchEvent[], trainMonths: number): Array<{ train: HistoricalLaunchEvent[]; test: HistoricalLaunchEvent[]; testMonth: string }> => {
  const byMonth = new Map<string, HistoricalLaunchEvent[]>();
  for (const event of events) {
    const month = new Date(event.timestamp).toISOString().slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) || []), event]);
  }
  const months = [...byMonth.keys()].sort();
  const windows: Array<{ train: HistoricalLaunchEvent[]; test: HistoricalLaunchEvent[]; testMonth: string }> = [];
  for (let index = trainMonths; index < months.length; index += 1) {
    windows.push({
      train: months.slice(index - trainMonths, index).flatMap((month) => byMonth.get(month) || []),
      test: byMonth.get(months[index]) || [],
      testMonth: months[index]
    });
  }
  return windows;
};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }
  return values[Math.max(0, Math.min(values.length - 1, Math.floor((values.length - 1) * p)))];
};

const aggregateResults = (scenarios: ScenarioResult[]): BacktestSuiteResult["aggregate"] => {
  const trades = scenarios.reduce((sum, item) => sum + item.metrics.trades, 0);
  const pnlSol = scenarios.reduce((sum, item) => sum + item.metrics.pnlSol, 0);
  const winRate = scenarios.reduce((sum, item) => sum + item.metrics.winRate * item.metrics.trades, 0) / Math.max(trades, 1);
  const sharpe = scenarios.reduce((sum, item) => sum + item.metrics.sharpe * item.metrics.trades, 0) / Math.max(trades, 1);
  const maxDrawdownPct = Math.max(...scenarios.map((item) => item.metrics.maxDrawdownPct));
  return {
    trades,
    winRate,
    sharpe,
    maxDrawdownPct,
    pnlSol,
    passed: scenarios.every((item) => item.passed)
  };
};

export const main = async (): Promise<void> => {
  const logger = createLogger("info", { service: "backtest_runner" });
  const result = await runBacktestSuite(20260505, logger);
  for (const scenario of result.scenarios) {
    logger.info({
      scenario: scenario.scenario,
      events: scenario.events,
      trades: scenario.metrics.trades,
      winRate: Number((scenario.metrics.winRate * 100).toFixed(2)),
      sharpe: Number(scenario.metrics.sharpe.toFixed(3)),
      maxDrawdownPct: Number(scenario.metrics.maxDrawdownPct.toFixed(2)),
      pnlSol: Number(scenario.metrics.pnlSol.toFixed(6)),
      monteCarlo: scenario.monteCarlo,
      passed: scenario.passed
    }, "backtest_scenario_result");
  }
  logger.info({
    trades: result.aggregate.trades,
    winRate: Number((result.aggregate.winRate * 100).toFixed(2)),
    sharpe: Number(result.aggregate.sharpe.toFixed(3)),
    maxDrawdownPct: Number(result.aggregate.maxDrawdownPct.toFixed(2)),
    pnlSol: Number(result.aggregate.pnlSol.toFixed(6)),
    passed: result.aggregate.passed
  }, "backtest_aggregate_result");
  if (!result.aggregate.passed) {
    process.exitCode = 1;
  }
};

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";

if (import.meta.url === entryUrl) {
  main().catch((error) => {
    const logger = createLogger("error", { service: "backtest_runner" });
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "backtest_runner_failed");
    process.exitCode = 1;
  });
}
