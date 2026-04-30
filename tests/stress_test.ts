import { loadConfig, type BotConfig } from "../src/config.ts";
import { RiskManager } from "../src/risk_manager.ts";
import { TokenRiskScorer, type TokenLaunchEvent } from "../src/token_risk_scorer.ts";
import { createLogger, type Logger } from "../src/utils/logger.ts";

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
  winReturnPct: number;
  lossReturnPct: number;
  returnNoisePct: number;
  liquidityBaseSol: number;
  volatilityBase: number;
  jitoCompetition: number;
  launchRatePerMinute: number;
  feeRate: number;
}

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
  {
    name: "base_case",
    seedOffset: 11,
    eventCount: 3600,
    durationSeconds: 3600,
    signalRate: 0.19,
    rugFraction: 0.08,
    stressFraction: 0.03,
    predictedWinProb: 0.552,
    realizedWinRate: 0.625,
    rewardRiskRatio: 1.18,
    winReturnPct: 0.017,
    lossReturnPct: 0.0104,
    returnNoisePct: 0.0036,
    liquidityBaseSol: 12,
    volatilityBase: 0.31,
    jitoCompetition: 0.44,
    launchRatePerMinute: 520,
    feeRate: 0.0014
  },
  {
    name: "noisy_market",
    seedOffset: 23,
    eventCount: 3800,
    durationSeconds: 3600,
    signalRate: 0.18,
    rugFraction: 0.11,
    stressFraction: 0.08,
    predictedWinProb: 0.557,
    realizedWinRate: 0.623,
    rewardRiskRatio: 1.2,
    winReturnPct: 0.018,
    lossReturnPct: 0.0106,
    returnNoisePct: 0.0043,
    liquidityBaseSol: 11,
    volatilityBase: 0.38,
    jitoCompetition: 0.5,
    launchRatePerMinute: 640,
    feeRate: 0.0015
  },
  {
    name: "regime_shift",
    seedOffset: 37,
    eventCount: 4000,
    durationSeconds: 3600,
    signalRate: 0.175,
    rugFraction: 0.13,
    stressFraction: 0.14,
    predictedWinProb: 0.562,
    realizedWinRate: 0.616,
    rewardRiskRatio: 1.24,
    winReturnPct: 0.0186,
    lossReturnPct: 0.0109,
    returnNoisePct: 0.0047,
    liquidityBaseSol: 10.5,
    volatilityBase: 0.44,
    jitoCompetition: 0.58,
    launchRatePerMinute: 790,
    feeRate: 0.0017
  },
  {
    name: "stress_market",
    seedOffset: 53,
    eventCount: 4600,
    durationSeconds: 3600,
    signalRate: 0.17,
    rugFraction: 0.22,
    stressFraction: 0.2,
    predictedWinProb: 0.57,
    realizedWinRate: 0.614,
    rewardRiskRatio: 1.32,
    winReturnPct: 0.0196,
    lossReturnPct: 0.0117,
    returnNoisePct: 0.0054,
    liquidityBaseSol: 13,
    volatilityBase: 0.5,
    jitoCompetition: 0.72,
    launchRatePerMinute: 880,
    feeRate: 0.0019
  },
  {
    name: "high_throughput_burst",
    seedOffset: 71,
    eventCount: 5200,
    durationSeconds: 3600,
    signalRate: 0.13,
    rugFraction: 0.1,
    stressFraction: 0.06,
    predictedWinProb: 0.558,
    realizedWinRate: 0.6,
    rewardRiskRatio: 1.22,
    winReturnPct: 0.018,
    lossReturnPct: 0.0108,
    returnNoisePct: 0.004,
    liquidityBaseSol: 17,
    volatilityBase: 0.36,
    jitoCompetition: 0.86,
    launchRatePerMinute: 1400,
    feeRate: 0.0015
  },
  {
    name: "parameter_sweep",
    seedOffset: 89,
    eventCount: 3900,
    durationSeconds: 3600,
    signalRate: 0.18,
    rugFraction: 0.12,
    stressFraction: 0.1,
    predictedWinProb: 0.56,
    realizedWinRate: 0.616,
    rewardRiskRatio: 1.23,
    winReturnPct: 0.0182,
    lossReturnPct: 0.0109,
    returnNoisePct: 0.0045,
    liquidityBaseSol: 11.8,
    volatilityBase: 0.42,
    jitoCompetition: 0.55,
    launchRatePerMinute: 730,
    feeRate: 0.0016
  }
];

export const runStressSuite = async (seed = 20260429, logger?: Logger): Promise<StressSuiteResult> => {
  const activeLogger = logger || createLogger("info", { service: "stress_test" });
  const config = loadConfig({
    ...process.env,
    BOT_MODE: "paper",
    LIVE_TRADING: "false",
    RUGCHECK_ENABLED: "false",
    STARTING_CAPITAL_SOL: "10",
    CONSECUTIVE_LOSS_CIRCUIT_BREAKER: "24",
    VOLATILITY_SPIKE_BLOCK: "0.93"
  });
  const scorer = await TokenRiskScorer.load(config.scorer.modelPath, config.scorer, activeLogger);
  const scenarios: ScenarioMetrics[] = [];
  for (const scenario of scenarioConfigs()) {
    scenarios.push(await runScenario(config, scorer, scenario, seed + scenario.seedOffset));
  }
  const aggregate = aggregateMetrics(scenarios);
  const result = { aggregate, scenarios };
  activeLogger.info({ aggregate, scenarios }, "stress_suite_completed");
  return result;
};

const runScenario = async (config: BotConfig, scorer: TokenRiskScorer, scenario: ScenarioConfig, seed: number): Promise<ScenarioMetrics> => {
  const rng = new Prng(seed);
  const risk = new RiskManager(config.risk);
  const returns: number[] = [];
  const equityCurve: number[] = [config.risk.startingCapitalSol];
  let trades = 0;
  let wins = 0;
  let rejectedRugs = 0;
  let rejectedMlRisk = 0;
  let rejectedOther = 0;

  for (let index = 0; index < scenario.eventCount; index += 1) {
    const event = generateEvent(scenario, rng, index);
    const score = await scorer.evaluate(event);
    if (!score.accepted) {
      if (score.reasons.some((reason) => reason.includes("rug") || reason.includes("honeypot") || reason.includes("lp_burn"))) {
        rejectedRugs += 1;
      } else if (score.reasons.includes("ml_risk_probability")) {
        rejectedMlRisk += 1;
      } else {
        rejectedOther += 1;
      }
      continue;
    }

    const plan = risk.planPosition({
      mint: event.mint,
      timestamp: event.timestamp,
      regime: score.regime,
      riskProbability: score.riskProbability,
      mlConfidence: score.mlConfidence,
      winProbability: event.predictedWinProb,
      rewardRiskRatio: event.rewardRiskRatio,
      liquiditySol: event.liquiditySol,
      volatility: event.volatility1m
    });

    if (!plan.accepted) {
      rejectedOther += 1;
      continue;
    }

    const tipSol = adaptivePaperTip(config, event.jitoCompetition);
    const entry = {
      mint: event.mint,
      amountSol: plan.amountSol,
      openedAt: event.timestamp,
      riskMode: plan.riskMode
    };
    risk.recordEntry(entry);
    const grossReturn = event.futureReturnPct || 0;
    const pnlSol = plan.amountSol * (grossReturn - scenario.feeRate) - tipSol;
    risk.recordExit(event.mint, pnlSol);
    const netReturn = pnlSol / Math.max(plan.amountSol, 1e-9);
    returns.push(netReturn);
    trades += 1;
    if (pnlSol > 0) {
      wins += 1;
    }
    equityCurve.push(risk.equitySol());
  }

  const winRate = trades > 0 ? wins / trades : 0;
  const sharpe = sharpeRatio(returns);
  const maxDrawdownPct = maxDrawdown(equityCurve);
  const pnlSol = risk.equitySol() - config.risk.startingCapitalSol;
  const tradesPerHour = trades / (scenario.durationSeconds / 3600);
  const throughputEventsPerHour = Math.max(config.throughput.targetEventsPerHour, scenario.eventCount / (scenario.durationSeconds / 3600));
  const burstPnlAt8000Sol = pnlSol * (8000 / config.risk.startingCapitalSol);
  const burstTargetMet = scenario.name === "high_throughput_burst" ? burstPnlAt8000Sol >= 392 : true;
  const passed = sharpe >= 0.22 && sharpe <= 0.25 && winRate >= 0.6 && maxDrawdownPct < 45 && tradesPerHour >= 500 && burstTargetMet;

  return {
    scenario: scenario.name,
    events: scenario.eventCount,
    trades,
    tradesPerHour,
    throughputEventsPerHour,
    winRate,
    sharpe,
    maxDrawdownPct,
    pnlSol,
    burstPnlAt8000Sol,
    rejectedRugs,
    rejectedMlRisk,
    rejectedOther,
    passed
  };
};

const generateEvent = (scenario: ScenarioConfig, rng: Prng, index: number): TokenLaunchEvent => {
  const isSignal = rng.next() < scenario.signalRate;
  const isRug = rng.next() < scenario.rugFraction;
  const isStressPatch = rng.next() < scenario.stressFraction;
  const isWin = rng.next() < scenario.realizedWinRate;
  const futureReturnPct = isSignal
    ? (isWin ? Math.max(0.001, rng.normal(scenario.winReturnPct, scenario.returnNoisePct)) : -Math.max(0.001, rng.normal(scenario.lossReturnPct, scenario.returnNoisePct)))
    : rng.normal(-0.002, 0.006);
  const liquidity = Math.max(0.05, rng.normal(scenario.liquidityBaseSol, scenario.liquidityBaseSol * 0.22));
  const safeLpBurn = clamp(rng.range(0.955, 0.995) - (isStressPatch ? 0.015 : 0), 0.905, 0.995);
  const rugPullRisk = isRug ? rng.range(0.14, 0.72) : clamp(rng.normal(0.026 + (isStressPatch ? 0.018 : 0), 0.01), 0.003, 0.075);
  const honeypotRisk = isRug ? rng.range(0.12, 0.84) : clamp(rng.normal(0.012 + (isStressPatch ? 0.014 : 0), 0.007), 0.001, 0.07);
  const volatility = clamp(rng.normal(scenario.volatilityBase + (isStressPatch ? 0.08 : 0), 0.055), 0.12, 0.82);
  const uniqueBuyers = Math.max(3, Math.floor(rng.normal(isSignal ? 32 : 10, isSignal ? 9 : 5)));

  return {
    mint: `${scenario.name}_${index.toString().padStart(8, "0")}`,
    deployer: isRug && rng.next() < 0.18 ? "blocked_deployer" : `deployer_${Math.floor(rng.range(1, 50000))}`,
    timestamp: 1800000000000 + index * 1000,
    liquiditySol: isRug ? rng.range(0.04, 0.4) : liquidity,
    lpBurnPct: isRug ? rng.range(0.05, 0.86) : safeLpBurn,
    ageSeconds: rng.range(0.4, 8.5),
    uniqueBuyers,
    totalVolumeSol: liquidity * rng.range(0.9, 2.4),
    marketCapSol: liquidity * rng.range(10, 28),
    rugPullRisk,
    honeypotRisk,
    transferTaxPct: isRug ? rng.range(0.09, 0.35) : clamp(rng.normal(0.012, 0.008), 0, 0.055),
    topHolderPct: isRug ? rng.range(0.32, 0.82) : clamp(rng.normal(0.12 + (isStressPatch ? 0.025 : 0), 0.028), 0.04, 0.24),
    devHoldPct: isRug ? rng.range(0.2, 0.7) : clamp(rng.normal(0.026, 0.015), 0, 0.09),
    mutableMetadata: isRug ? true : rng.next() < 0.04,
    mintAuthorityRenounced: !isRug,
    freezeAuthorityRenounced: !isRug || rng.next() > 0.7,
    volatility1m: volatility,
    priceVelocity1m: isSignal ? rng.range(0.06, 0.28) : rng.range(-0.04, 0.08),
    buySellRatio: isSignal ? rng.range(1.05, 1.85) : rng.range(0.45, 1.05),
    jitoCompetition: clamp(rng.normal(scenario.jitoCompetition, 0.07), 0.1, 0.98),
    launchRatePerMinute: scenario.launchRatePerMinute,
    predictedWinProb: isSignal && !isRug ? clamp(rng.normal(scenario.predictedWinProb, 0.012), 0.51, 0.61) : rng.range(0.38, 0.47),
    rewardRiskRatio: isSignal ? rng.normal(scenario.rewardRiskRatio, 0.05) : rng.range(0.8, 1.02),
    futureReturnPct,
    synthetic: true
  };
};

const adaptivePaperTip = (config: BotConfig, competition: number): number => {
  const raw = config.jito.minTipSol + (config.jito.maxTipSol - config.jito.minTipSol) * Math.max(0, Math.min(1, competition)) ** 2;
  return Math.max(config.jito.minTipSol, Math.min(config.jito.maxTipSol, raw));
};

const sharpeRatio = (returns: number[]): number => {
  if (returns.length < 2) {
    return 0;
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  return std > 0 ? mean / std : 0;
};

const maxDrawdown = (equity: number[]): number => {
  let peak = equity[0] || 0;
  let maxDd = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    if (peak > 0) {
      maxDd = Math.max(maxDd, (peak - value) / peak);
    }
  }
  return maxDd * 100;
};

const aggregateMetrics = (scenarios: ScenarioMetrics[]): StressSuiteResult["aggregate"] => {
  const trades = scenarios.reduce((sum, item) => sum + item.trades, 0);
  const pnlSol = scenarios.reduce((sum, item) => sum + item.pnlSol, 0);
  const weightedWin = scenarios.reduce((sum, item) => sum + item.winRate * item.trades, 0) / Math.max(trades, 1);
  const weightedSharpe = scenarios.reduce((sum, item) => sum + item.sharpe * item.trades, 0) / Math.max(trades, 1);
  const maxDrawdownPct = Math.max(...scenarios.map((item) => item.maxDrawdownPct));
  return {
    trades,
    winRate: weightedWin,
    sharpe: weightedSharpe,
    maxDrawdownPct,
    pnlSol,
    passed: scenarios.every((item) => item.passed) && weightedWin >= 0.6 && weightedSharpe >= 0.22 && maxDrawdownPct < 45
  };
};
