/**
 * engine/regime-detector.ts
 *
 * Market regime detector classifying conditions into:
 *   ACCELERATING | NORMAL | FRAGILE | STRESS
 *
 * Uses rolling windows of:
 *   - Recent win rate
 *   - Recent Sharpe ratio
 *   - Drawdown slope
 *   - Slippage trends
 *   - Failed fill rate
 *   - Token launch quality distribution
 *
 * Returns regime state + multipliers for downstream sizing/routing.
 */

import {
  MarketRegime,
  RegimeSnapshot,
  RegimeMultipliers,
  TradeOutcome,
} from './types';

// ─── Configuration ──────────────────────────────────────────────────

export interface RegimeDetectorConfig {
  /** Rolling window size for computing regime metrics */
  readonly windowSize: number;
  /** Minimum samples before declaring non-NORMAL regime */
  readonly minSamples: number;

  // ── Regime thresholds ──
  /** Win rate above this → ACCELERATING candidate */
  readonly acceleratingWinRate: number;
  /** Sharpe above this → ACCELERATING candidate */
  readonly acceleratingSharpe: number;

  /** Drawdown slope above this → FRAGILE */
  readonly fragileDrawdownSlope: number;
  /** Slippage trend above this → FRAGILE */
  readonly fragileSlippageTrend: number;

  /** Sharpe below this → STRESS */
  readonly stressSharpe: number;
  /** Failed fill rate above this → STRESS */
  readonly stressFailedFillRate: number;
  /** Win rate below this → STRESS */
  readonly stressWinRate: number;

  /** EMA decay for smoothing metrics */
  readonly emaAlpha: number;
}

const DEFAULT_CONFIG: RegimeDetectorConfig = {
  windowSize: 100,
  minSamples: 15,
  acceleratingWinRate: 0.65,
  acceleratingSharpe: 1.5,
  fragileDrawdownSlope: 0.5,
  fragileSlippageTrend: 0.15,
  stressSharpe: -0.2,
  stressFailedFillRate: 0.35,
  stressWinRate: 0.35,
  emaAlpha: 0.1,
};

// ─── Regime Multipliers Lookup ───────────────────────────────────────

const REGIME_MULTIPLIERS: Readonly<Record<MarketRegime, RegimeMultipliers>> = {
  [MarketRegime.ACCELERATING]: {
    sizeMultiplier: 1.4,
    scoreThresholdOffset: -0.05,
    concurrencyMultiplier: 1.3,
    riskMultiplier: 1.2,
  },
  [MarketRegime.NORMAL]: {
    sizeMultiplier: 1.0,
    scoreThresholdOffset: 0.0,
    concurrencyMultiplier: 1.0,
    riskMultiplier: 1.0,
  },
  [MarketRegime.FRAGILE]: {
    sizeMultiplier: 0.65,
    scoreThresholdOffset: 0.05,
    concurrencyMultiplier: 0.7,
    riskMultiplier: 0.7,
  },
  [MarketRegime.STRESS]: {
    sizeMultiplier: 0.35,
    scoreThresholdOffset: 0.12,
    concurrencyMultiplier: 0.5,
    riskMultiplier: 0.4,
  },
};

// ─── Regime Detector ─────────────────────────────────────────────────

export class TradingRegimeDetector {
  private readonly config: RegimeDetectorConfig;

  // Rolling buffers
  private readonly outcomes: TradeOutcome[] = [];
  private fillAttempts = 0;
  private failedFills = 0;
  private launchQualityScores: number[] = [];

  // EMA-smoothed metrics
  private emaWinRate = 0.5;
  private emaSharpe = 0;
  private emaDrawdownSlope = 0;
  private emaSlippageTrend = 0;

  // Current state
  private currentRegime: MarketRegime = MarketRegime.NORMAL;
  private regimeHistory: Array<{ regime: MarketRegime; timestamp: number }> = [];
  private forcedRegime: MarketRegime | null = null;

  constructor(config?: Partial<RegimeDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a completed trade outcome for regime detection.
   */
  recordOutcome(outcome: TradeOutcome): void {
    this.outcomes.push(outcome);

    // Trim to window
    while (this.outcomes.length > this.config.windowSize) {
      this.outcomes.shift();
    }

    // Update EMA metrics
    this.updateMetrics();
  }

  /**
   * Record a fill attempt (for failed-fill-rate tracking).
   */
  recordFillAttempt(succeeded: boolean): void {
    this.fillAttempts++;
    if (!succeeded) this.failedFills++;

    // Decay old attempts periodically
    if (this.fillAttempts > this.config.windowSize * 3) {
      this.fillAttempts = Math.ceil(this.fillAttempts * 0.7);
      this.failedFills = Math.ceil(this.failedFills * 0.7);
    }
  }

  /**
   * Record a token launch quality score (0–1).
   */
  recordLaunchQuality(score: number): void {
    this.launchQualityScores.push(score);
    while (this.launchQualityScores.length > this.config.windowSize) {
      this.launchQualityScores.shift();
    }
  }

  /**
   * Detect the current market regime based on all tracked metrics.
   */
  detect(): RegimeSnapshot {
    const metrics = this.computeMetrics();
    const regime = this.forcedRegime ?? this.classifyRegime(metrics);

    if (regime !== this.currentRegime) {
      this.regimeHistory.push({ regime, timestamp: Date.now() });
      this.currentRegime = regime;
    }

    return {
      regime,
      recentWinRate: metrics.winRate,
      recentSharpe: metrics.sharpe,
      drawdownSlope: metrics.drawdownSlope,
      slippageTrend: metrics.slippageTrend,
      failedFillRate: metrics.failedFillRate,
      tokenLaunchQuality: metrics.launchQuality,
      confidence: this.forcedRegime ? 1 : metrics.confidence,
      timestamp: Date.now(),
    };
  }

  setForcedRegime(regime: MarketRegime | null): void {
    this.forcedRegime = regime;
  }

  /**
   * Get regime-specific multipliers for the current regime.
   */
  getMultipliers(): RegimeMultipliers {
    return REGIME_MULTIPLIERS[this.currentRegime];
  }

  /**
   * Get the current regime without re-computing (cached result).
   */
  getCurrentRegime(): MarketRegime {
    return this.currentRegime;
  }

  getRegimeHistory(): Array<{ regime: MarketRegime; timestamp: number }> {
    return [...this.regimeHistory];
  }

  // ── Private ────────────────────────────────────────────────────────

  private updateMetrics(): void {
    const alpha = this.config.emaAlpha;
    const recent = this.outcomes.slice(-20);

    if (recent.length > 0) {
      // Win rate
      const wins = recent.filter((o) => o.pnlSol > 0).length;
      const rawWinRate = wins / recent.length;
      this.emaWinRate = alpha * rawWinRate + (1 - alpha) * this.emaWinRate;

      // Sharpe
      const returns = recent.map((o) => o.pnlPct);
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance =
        returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
      const std = Math.sqrt(variance);
      const rawSharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
      this.emaSharpe = alpha * rawSharpe + (1 - alpha) * this.emaSharpe;

      // Drawdown slope: rate of equity decline
      const pnls = recent.map((o) => o.pnlSol);
      const cumPnl = pnls.reduce((acc, p) => {
        acc.push((acc[acc.length - 1] ?? 0) + p);
        return acc;
      }, [] as number[]);
      let maxDD = 0;
      let peak = 0;
      for (const v of cumPnl) {
        peak = Math.max(peak, v);
        maxDD = Math.max(maxDD, peak - v);
      }
      const ddSlope = maxDD / Math.max(recent.length, 1);
      this.emaDrawdownSlope = alpha * ddSlope + (1 - alpha) * this.emaDrawdownSlope;

      // Slippage trend
      const avgSlippage =
        recent.reduce((a, b) => a + b.slippageEntry, 0) / recent.length;
      this.emaSlippageTrend = alpha * avgSlippage + (1 - alpha) * this.emaSlippageTrend;
    }
  }

  private computeMetrics(): RegimeMetrics {
    const n = this.outcomes.length;
    const failedFillRate =
      this.fillAttempts > 0 ? this.failedFills / this.fillAttempts : 0;

    const launchQuality =
      this.launchQualityScores.length > 0
        ? this.launchQualityScores.reduce((a, b) => a + b, 0) /
          this.launchQualityScores.length
        : 0.5;

    // Confidence based on sample count
    const confidence = Math.min(1, n / this.config.minSamples);

    return {
      winRate: this.emaWinRate,
      sharpe: this.emaSharpe,
      drawdownSlope: this.emaDrawdownSlope,
      slippageTrend: this.emaSlippageTrend,
      failedFillRate,
      launchQuality,
      confidence,
      sampleCount: n,
    };
  }

  private classifyRegime(metrics: RegimeMetrics): MarketRegime {
    const c = this.config;

    // Not enough data → stay NORMAL
    if (metrics.sampleCount < c.minSamples) {
      return MarketRegime.NORMAL;
    }

    // STRESS: worst conditions first (takes priority)
    if (
      metrics.sharpe < c.stressSharpe ||
      metrics.failedFillRate > c.stressFailedFillRate ||
      metrics.winRate < c.stressWinRate
    ) {
      return MarketRegime.STRESS;
    }

    // FRAGILE: deteriorating but not yet stress
    if (
      metrics.drawdownSlope > c.fragileDrawdownSlope ||
      metrics.slippageTrend > c.fragileSlippageTrend
    ) {
      return MarketRegime.FRAGILE;
    }

    // ACCELERATING: strong performance
    if (
      metrics.winRate > c.acceleratingWinRate &&
      metrics.sharpe > c.acceleratingSharpe
    ) {
      return MarketRegime.ACCELERATING;
    }

    return MarketRegime.NORMAL;
  }
}

// ─── Internal Types ──────────────────────────────────────────────────

interface RegimeMetrics {
  winRate: number;
  sharpe: number;
  drawdownSlope: number;
  slippageTrend: number;
  failedFillRate: number;
  launchQuality: number;
  confidence: number;
  sampleCount: number;
}
