import {
  ExecutionResult,
  MarketRegime,
  PipelineDecision,
  ScenarioConfig,
  SizingBucket,
  TokenSignal,
  TradeOutcome,
} from './types';

export interface ScenarioRealismAssumptions {
  readonly latentRugPullRate: number;
  readonly largeOrderThresholdSol: number;
  readonly largeOrderEntrySlippagePct: number;
  readonly largeOrderExitSlippagePct: number;
  readonly mevRejectRate: number;
  readonly stressLatencyP95Ms: number;
}

export interface ScenarioSignalContext {
  readonly signal: TokenSignal;
  readonly relativeTimeMs: number;
  readonly scheduledRegime: MarketRegime;
  readonly latentRugPull: boolean;
  readonly rugPullTimeMs: number | null;
  readonly qualityBias: number;
  readonly pathVolatility: number;
  readonly congestionPenalty: number;
}

export const DEFAULT_SCENARIO_REALISM: ScenarioRealismAssumptions = {
  latentRugPullRate: 0.25,
  largeOrderThresholdSol: 0.1,
  largeOrderEntrySlippagePct: 0.02,
  largeOrderExitSlippagePct: 0.03,
  mevRejectRate: 0.15,
  stressLatencyP95Ms: 250,
};

const REGIME_PROFILES: Record<
  MarketRegime,
  {
    liquidityMin: number;
    liquidityMax: number;
    visibleRugMultiplier: number;
    slippageBoost: number;
    qualityBias: number;
    volatilityBoost: number;
    socialFloor: number;
  }
> = {
  [MarketRegime.ACCELERATING]: {
    liquidityMin: 2.0,
    liquidityMax: 14.0,
    visibleRugMultiplier: 0.7,
    slippageBoost: 0.0,
    qualityBias: 0.05,
    volatilityBoost: 0.8,
    socialFloor: 0.4,
  },
  [MarketRegime.NORMAL]: {
    liquidityMin: 1.2,
    liquidityMax: 10.5,
    visibleRugMultiplier: 1.0,
    slippageBoost: 0.01,
    qualityBias: 0.0,
    volatilityBoost: 1.0,
    socialFloor: 0.3,
  },
  [MarketRegime.FRAGILE]: {
    liquidityMin: 0.7,
    liquidityMax: 7.0,
    visibleRugMultiplier: 1.15,
    slippageBoost: 0.02,
    qualityBias: -0.04,
    volatilityBoost: 1.25,
    socialFloor: 0.2,
  },
  [MarketRegime.STRESS]: {
    liquidityMin: 0.35,
    liquidityMax: 4.5,
    visibleRugMultiplier: 1.35,
    slippageBoost: 0.04,
    qualityBias: -0.08,
    volatilityBoost: 1.55,
    socialFloor: 0.05,
  },
};

const RETURN_PROFILES: Record<
  MarketRegime,
  {
    winnerMin: number;
    winnerMax: number;
    loserMin: number;
    loserMax: number;
    winRateShift: number;
  }
> = {
  [MarketRegime.ACCELERATING]: {
    winnerMin: 0.20,
    winnerMax: 0.33,
    loserMin: 0.04,
    loserMax: 0.10,
    winRateShift: 0.02,
  },
  [MarketRegime.NORMAL]: {
    winnerMin: 0.16,
    winnerMax: 0.28,
    loserMin: 0.04,
    loserMax: 0.09,
    winRateShift: 0.0,
  },
  [MarketRegime.FRAGILE]: {
    winnerMin: 0.13,
    winnerMax: 0.22,
    loserMin: 0.05,
    loserMax: 0.11,
    winRateShift: -0.04,
  },
  [MarketRegime.STRESS]: {
    winnerMin: 0.11,
    winnerMax: 0.17,
    loserMin: 0.06,
    loserMax: 0.13,
    winRateShift: -0.11,
  },
};

const HOLD_TIME_BY_BUCKET: Record<SizingBucket, { minMs: number; maxMs: number }> = {
  [SizingBucket.ULTRA_FAST_SNIPE]: { minMs: 15_000, maxMs: 70_000 },
  [SizingBucket.FAST_REACT]: { minMs: 35_000, maxMs: 120_000 },
  [SizingBucket.LATE_MOMENTUM]: { minMs: 70_000, maxMs: 210_000 },
  [SizingBucket.RECOVERY_MODE]: { minMs: 90_000, maxMs: 300_000 },
};

export function resolveScheduledRegime(
  schedule: ScenarioConfig['regimeSchedule'],
  relativeTimeMs: number,
): MarketRegime {
  let regime = schedule[0]?.regime ?? MarketRegime.NORMAL;

  for (const step of schedule) {
    if (relativeTimeMs >= step.atMs) {
      regime = step.regime;
    } else {
      break;
    }
  }

  return regime;
}

export function generateScenarioSignal(
  scenario: ScenarioConfig,
  index: number,
  assumptions: ScenarioRealismAssumptions = DEFAULT_SCENARIO_REALISM,
): ScenarioSignalContext {
  const relativeTimeMs = sampleRelativeTimeMs(scenario, index);
  const scheduledRegime = resolveScheduledRegime(scenario.regimeSchedule, relativeTimeMs);
  const profile = REGIME_PROFILES[scheduledRegime];
  const obviousRug = Math.random() < clamp(scenario.rugRate * profile.visibleRugMultiplier, 0, 0.9);

  const timeSinceLaunchSec = sampleLaunchAgeSec(scheduledRegime);
  const liquiditySol = obviousRug
    ? 0.15 + Math.random() * 0.95
    : profile.liquidityMin + Math.random() * (profile.liquidityMax - profile.liquidityMin);
  const uniqueBuyers = obviousRug
    ? 1 + Math.floor(Math.random() * 4)
    : 5 + Math.floor(liquiditySol * (1.2 + Math.random() * 1.4));
  const totalVolume = liquiditySol * (1.8 + Math.random() * 6.5);
  const marketCapSol = liquiditySol * (2.8 + Math.random() * 10.0);
  const buyersPerSol = uniqueBuyers / Math.max(liquiditySol, 0.05);
  const volumeToLpRatio = totalVolume / Math.max(liquiditySol, 0.05);
  const socialProxy = obviousRug
    ? Math.random() * 0.15
    : clamp(profile.socialFloor + Math.random() * 0.55, 0, 1);
  const priceGrowth = obviousRug
    ? -0.18 + Math.random() * 0.12
    : clamp(
        0.02 +
          profile.qualityBias * 0.5 +
          triangularNoise() * 0.08 * scenario.volatilityMultiplier,
        -1,
        1,
      );
  const lpGrowth = obviousRug
    ? -0.2 + Math.random() * 0.08
    : clamp(0.01 + triangularNoise() * 0.08, -1, 1);
  const slippageEstimate = clamp(
    scenario.slippageBase +
      profile.slippageBoost +
      0.018 / Math.sqrt(Math.max(liquiditySol, 0.1)) +
      (timeSinceLaunchSec < 2 ? 0.015 : 0),
    0.005,
    0.25,
  );

  const latentRugPull = Math.random() < assumptions.latentRugPullRate;
  const rugPullTimeMs = latentRugPull
    ? 10_000 + Math.pow(Math.random(), 1.85) * ((30 * 60 * 1000) - 10_000)
    : null;
  const qualityBias = clamp(
    profile.qualityBias +
      socialProxy * 0.08 +
      Math.max(0, priceGrowth) * 0.1 -
      slippageEstimate * 0.45 -
      (obviousRug ? 0.18 : 0),
    -0.18,
    0.14,
  );

  const timestamp = Date.now() + relativeTimeMs;
  const dt = new Date(timestamp);

  return {
    signal: {
      mint: `token_${index}_${Math.random().toString(36).slice(2, 10)}`,
      receivedAt: timestamp,
      liquiditySol,
      liquidityUsd: liquiditySol * 150,
      uniqueBuyers,
      totalVolume,
      marketCapSol,
      timeSinceLaunchSec,
      slippageEstimate,
      priceGrowth1s: priceGrowth,
      socialProxy1s: socialProxy,
      lpGrowth1s: lpGrowth,
      buyersPerSol,
      volumeToLpRatio,
      logLiquidity: Math.log1p(liquiditySol),
      logVolume: Math.log1p(totalVolume),
      logMcap: Math.log1p(marketCapSol),
      hourOfDay: dt.getUTCHours(),
      dayOfWeek: dt.getUTCDay(),
      isWeekend: dt.getUTCDay() >= 5,
      mintEnabled: obviousRug && Math.random() < 0.2,
      isHoneypot: obviousRug && Math.random() < 0.18,
      isKnownRugDeployer: obviousRug && Math.random() < 0.1,
      lpLocked: obviousRug ? Math.random() < 0.25 : Math.random() < 0.72,
      lpBurned: !obviousRug && Math.random() < 0.28,
      sellTax: obviousRug ? 18 + Math.floor(Math.random() * 28) : Math.floor(Math.random() * 9),
      buyTax: obviousRug ? 8 + Math.floor(Math.random() * 16) : Math.floor(Math.random() * 6),
      ownershipRenounced: obviousRug ? Math.random() < 0.35 : Math.random() < 0.68,
      top10HolderPct: obviousRug ? 58 + Math.random() * 32 : 18 + Math.random() * 32,
      devWalletPct: obviousRug ? 12 + Math.random() * 24 : Math.random() * 8,
      walletClusterScore: obviousRug ? 0.45 + Math.random() * 0.45 : Math.random() * 0.35,
      hasTelegram: !obviousRug && Math.random() < 0.6,
      hasTwitter: !obviousRug && Math.random() < 0.55,
      followerQualityScore: !obviousRug ? 0.25 + Math.random() * 0.65 : Math.random() * 0.2,
    },
    relativeTimeMs,
    scheduledRegime,
    latentRugPull,
    rugPullTimeMs,
    qualityBias,
    pathVolatility: scenario.volatilityMultiplier * profile.volatilityBoost,
    congestionPenalty: Math.min(0.2, (scenario.launchRatePerMin / 200) * 0.16),
  };
}

export function simulateScenarioOutcome(opts: {
  decision: PipelineDecision;
  execution: ExecutionResult;
  context: ScenarioSignalContext;
  assumptions?: ScenarioRealismAssumptions;
}): TradeOutcome {
  const { decision, execution, context } = opts;
  const assumptions = opts.assumptions ?? DEFAULT_SCENARIO_REALISM;
  const bucket = decision.sizing?.bucket ?? decision.order?.bucket ?? SizingBucket.FAST_REACT;
  const regime = context.scheduledRegime;
  const returnProfile = RETURN_PROFILES[regime];
  const holdRange = HOLD_TIME_BY_BUCKET[bucket];
  const holdTimeMs = holdRange.minMs + Math.random() * (holdRange.maxMs - holdRange.minMs);
  const confidence = decision.prediction?.confidence ?? 0.5;
  const expectedEdge = decision.ranked?.expectedEdge ?? 0;
  const largeOrder = execution.fillSizeSol > assumptions.largeOrderThresholdSol;
  const sizePenalty = Math.max(0, execution.fillSizeSol - 0.05) * 0.7;
  const rugTriggered =
    context.latentRugPull &&
    context.rugPullTimeMs !== null &&
    context.rugPullTimeMs <= holdTimeMs;

  const winProbability = clamp(
    0.6 +
      returnProfile.winRateShift +
      context.qualityBias * 0.75 +
      (confidence - 0.55) * 0.12 +
      Math.max(-0.02, Math.min(expectedEdge, 0.035)) * 1.8 -
      context.signal.slippageEstimate * 0.18 -
      context.congestionPenalty -
      sizePenalty,
    0.38,
    0.8,
  );

  let grossMove: number;
  if (rugTriggered) {
    grossMove = -0.95;
  } else if (Math.random() < winProbability) {
    grossMove =
      returnProfile.winnerMin +
      Math.random() * (returnProfile.winnerMax - returnProfile.winnerMin) +
      triangularNoise() * 0.025 * context.pathVolatility;
  } else {
    grossMove =
      -(
        returnProfile.loserMin +
        Math.random() * (returnProfile.loserMax - returnProfile.loserMin)
      ) +
      triangularNoise() * 0.015 * context.pathVolatility;
  }

  const entrySlippage = clamp(
    execution.slippagePct * 0.75 +
      context.signal.slippageEstimate * 0.1 +
      context.congestionPenalty * 0.1 +
      (largeOrder ? assumptions.largeOrderEntrySlippagePct : 0),
    0,
    0.22,
  );
  const exitSlippage = clamp(
    context.signal.slippageEstimate * (getExitSlippageMultiplier(regime) * 0.65) +
      context.congestionPenalty * 0.08 +
      (largeOrder ? assumptions.largeOrderExitSlippagePct : 0),
    0,
    0.24,
  );
  const latencyPenalty = clamp(Math.max(0, execution.latencyMs - 150) / 7000, 0, 0.02);
  const pnlPct = clamp(grossMove - entrySlippage - exitSlippage - latencyPenalty, -0.985, 0.32);
  const pnlSol = execution.fillSizeSol * pnlPct;
  const fillQuality = clamp(
    1 - (entrySlippage + exitSlippage) * 1.7 - Math.max(0, execution.latencyMs - 140) / 650,
    0.05,
    0.98,
  );

  return {
    mint: context.signal.mint,
    entryTimestamp: decision.decisionTimestamp,
    exitTimestamp: decision.decisionTimestamp + holdTimeMs,
    entrySizeSol: execution.fillSizeSol,
    pnlSol,
    pnlPct,
    holdTimeMs,
    slippageEntry: entrySlippage,
    slippageExit: exitSlippage,
    fillQuality,
    bucket,
    regime,
    mlScoreAtEntry: confidence,
    expectedEdgeAtEntry: expectedEdge,
  };
}

function sampleRelativeTimeMs(scenario: ScenarioConfig, index: number): number {
  const spacing = scenario.tokenCount > 1
    ? scenario.durationMs / (scenario.tokenCount - 1)
    : scenario.durationMs;
  const centered = spacing * index;
  const jitter = spacing * 0.35 * triangularNoise();
  return clamp(centered + jitter, 0, scenario.durationMs);
}

function sampleLaunchAgeSec(regime: MarketRegime): number {
  const bucketRoll = Math.random();

  if (bucketRoll < 0.18) {
    return Math.random() * 2;
  }
  if (bucketRoll < 0.5) {
    return 2 + Math.random() * 4;
  }
  if (bucketRoll < 0.88) {
    return 6 + Math.random() * 9;
  }

  return regime === MarketRegime.STRESS
    ? 15 + Math.random() * 35
    : 15 + Math.random() * 20;
}

function getExitSlippageMultiplier(regime: MarketRegime): number {
  switch (regime) {
    case MarketRegime.ACCELERATING:
      return 0.9;
    case MarketRegime.NORMAL:
      return 1.05;
    case MarketRegime.FRAGILE:
      return 1.2;
    case MarketRegime.STRESS:
      return 1.45;
    default:
      return 1.0;
  }
}

function triangularNoise(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
