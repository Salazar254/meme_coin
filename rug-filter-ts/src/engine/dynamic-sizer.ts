/**
 * engine/dynamic-sizer.ts
 *
 * Dynamic position sizing engine that allocates capital based on:
 *   - ML confidence
 *   - Regime state
 *   - Token quality (liquidity, freshness)
 *   - Current drawdown
 *   - Open exposure
 *
 * Key behaviors:
 *   - Scale up AGGRESSIVELY only for top-decile opportunities
 *   - Reduce size automatically when drawdown rises
 *   - Support bucket-based sizing: ultra-fast, fast react, late momentum, recovery
 */

import {
  SizingBucket,
  SizingRequest,
  SizingResult,
  RankedOpportunity,
  RegimeSnapshot,
  MarketRegime,
} from './types';

// ─── Configuration ──────────────────────────────────────────────────

export interface DynamicSizerConfig {
  /** Base position size as % of equity */
  readonly basePositionPct: number;
  /** Maximum position size as % of equity */
  readonly maxPositionPct: number;
  /** Minimum position size in SOL (floor) */
  readonly minPositionSol: number;
  /** Maximum position size in SOL (absolute cap) */
  readonly maxPositionSol: number;
  /** Total open exposure cap (% of equity) */
  readonly maxOpenExposurePct: number;
  /** Max concurrent position count */
  readonly maxConcurrentPositions: number;

  /** Top-decile threshold (composite rank must be above this percentile) */
  readonly topDecileThreshold: number;
  /** Top-decile boosted size multiplier */
  readonly topDecileMultiplier: number;

  /** Drawdown scaling: at what DD% does sizing start reducing? */
  readonly drawdownScaleStartPct: number;
  /** Drawdown scaling: at what DD% is sizing at minimum? */
  readonly drawdownScaleFullPct: number;
  /** Minimum size factor when DD is at max */
  readonly drawdownMinFactor: number;

  /** Bucket-specific configuration */
  readonly bucketConfigs: Readonly<Record<SizingBucket, BucketConfig>>;
}

export interface BucketConfig {
  /** Max age (seconds since launch) for this bucket */
  readonly maxAgeSec: number;
  /** Min age (seconds since launch) for this bucket */
  readonly minAgeSec: number;
  /** Base risk multiplier for this bucket */
  readonly riskMultiplier: number;
  /** Min ML confidence required for this bucket */
  readonly minConfidence: number;
  /** Max exposure allocated to this bucket (% of equity) */
  readonly maxBucketExposurePct: number;
}

const DEFAULT_BUCKET_CONFIGS: Record<SizingBucket, BucketConfig> = {
  [SizingBucket.ULTRA_FAST_SNIPE]: {
    maxAgeSec: 2,
    minAgeSec: 0,
    riskMultiplier: 0.6,
    minConfidence: 0.55,
    maxBucketExposurePct: 4,
  },
  [SizingBucket.FAST_REACT]: {
    maxAgeSec: 6,
    minAgeSec: 2,
    riskMultiplier: 1.0,
    minConfidence: 0.45,
    maxBucketExposurePct: 6,
  },
  [SizingBucket.LATE_MOMENTUM]: {
    maxAgeSec: 15,
    minAgeSec: 6,
    riskMultiplier: 0.7,
    minConfidence: 0.6,
    maxBucketExposurePct: 4,
  },
  [SizingBucket.RECOVERY_MODE]: {
    maxAgeSec: 60,
    minAgeSec: 0,
    riskMultiplier: 0.3,
    minConfidence: 0.7,
    maxBucketExposurePct: 2,
  },
};

const DEFAULT_CONFIG: DynamicSizerConfig = {
  basePositionPct: 0.3,
  maxPositionPct: 0.8,
  minPositionSol: 0.01,
  maxPositionSol: 2.0,
  maxOpenExposurePct: 18,
  maxConcurrentPositions: 350,
  topDecileThreshold: 0.9,
  topDecileMultiplier: 2.5,
  drawdownScaleStartPct: 8,
  drawdownScaleFullPct: 25,
  drawdownMinFactor: 0.15,
  bucketConfigs: DEFAULT_BUCKET_CONFIGS,
};

// ─── Dynamic Sizer ──────────────────────────────────────────────────

export class DynamicSizer {
  private readonly config: DynamicSizerConfig;

  // Track recent composite ranks for percentile computation
  private recentCompositeRanks: number[] = [];
  private readonly maxRankHistory = 500;

  // Stats
  private totalSized = 0;
  private totalSkipped = 0;
  private bucketCounts: Map<SizingBucket, number> = new Map();
  private topDecileCount = 0;

  constructor(config?: Partial<DynamicSizerConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      bucketConfigs: {
        ...DEFAULT_BUCKET_CONFIGS,
        ...(config?.bucketConfigs ?? {}),
      },
    };
  }

  /**
   * Compute optimal position size for an opportunity.
   */
  size(request: SizingRequest): SizingResult | null {
    const { opportunity, regime, currentEquity, currentDrawdownPct, openExposurePct, openPositionCount } = request;

    // Concurrency check
    if (openPositionCount >= this.config.maxConcurrentPositions) {
      this.totalSkipped++;
      return null;
    }

    // Exposure check
    if (openExposurePct >= this.config.maxOpenExposurePct) {
      this.totalSkipped++;
      return null;
    }

    // Classify bucket
    const bucket = this.classifyBucket(opportunity, regime);
    const bucketConfig = this.config.bucketConfigs[bucket];

    // Confidence gate
    if (opportunity.prediction.confidence < bucketConfig.minConfidence) {
      this.totalSkipped++;
      return null;
    }

    // Track composite rank for percentile
    this.recordCompositeRank(opportunity.compositeRank);

    // Check if top-decile
    const isTopDecile = this.isTopDecile(opportunity.compositeRank);

    // ── Build size ──

    // 1. Base size from equity
    let sizeSol = currentEquity * (this.config.basePositionPct / 100);

    // 2. ML confidence scaling: linear from 0.5× to 1.5× based on confidence
    const confidenceScale = 0.5 + opportunity.prediction.confidence;
    sizeSol *= confidenceScale;

    // 3. Regime multiplier
    const regimeMultiplier = this.getRegimeMultiplier(regime);
    sizeSol *= regimeMultiplier;

    // 4. Bucket risk multiplier
    sizeSol *= bucketConfig.riskMultiplier;

    // 5. Edge-based scaling: expected edge drives conviction
    const edgeScale = Math.min(2.0, Math.max(0.5, 1 + opportunity.expectedEdge * 5));
    sizeSol *= edgeScale;

    // 6. Top-decile boost
    if (isTopDecile) {
      sizeSol *= this.config.topDecileMultiplier;
      this.topDecileCount++;
    }

    // 7. Drawdown scaling: reduce size as DD increases
    const ddFactor = this.computeDrawdownFactor(currentDrawdownPct);
    sizeSol *= ddFactor;

    // 8. Clamp
    sizeSol = Math.max(this.config.minPositionSol, sizeSol);
    sizeSol = Math.min(this.config.maxPositionSol, sizeSol);
    sizeSol = Math.min(currentEquity * (this.config.maxPositionPct / 100), sizeSol);

    // 9. Ensure remaining exposure headroom
    const remainingExposureSol = currentEquity * ((this.config.maxOpenExposurePct - openExposurePct) / 100);
    sizeSol = Math.min(sizeSol, Math.max(0, remainingExposureSol));

    if (sizeSol < this.config.minPositionSol) {
      this.totalSkipped++;
      return null;
    }

    const riskPct = currentEquity > 0 ? (sizeSol / currentEquity) * 100 : 0;

    const scaleFactor = confidenceScale * regimeMultiplier * bucketConfig.riskMultiplier * edgeScale * ddFactor * (isTopDecile ? this.config.topDecileMultiplier : 1);

    this.totalSized++;
    this.bucketCounts.set(bucket, (this.bucketCounts.get(bucket) ?? 0) + 1);

    return {
      bucket,
      positionSizeSol: sizeSol,
      riskPct,
      isTopDecile,
      reason: `bucket=${bucket} regime=${regime.regime} conf=${opportunity.prediction.confidence.toFixed(2)} edge=${opportunity.expectedEdge.toFixed(4)} dd_factor=${ddFactor.toFixed(2)} top10=${isTopDecile}`,
      scaleFactor,
    };
  }

  getStats(): Record<string, unknown> {
    const bucketBreakdown: Record<string, number> = {};
    for (const [bucket, count] of this.bucketCounts) {
      bucketBreakdown[bucket] = count;
    }
    return {
      totalSized: this.totalSized,
      totalSkipped: this.totalSkipped,
      topDecileCount: this.topDecileCount,
      bucketBreakdown,
      topDecileThreshold: this.getTopDecileThresholdValue(),
    };
  }

  // ── Private ────────────────────────────────────────────────────────

  private classifyBucket(
    opportunity: RankedOpportunity,
    regime: RegimeSnapshot,
  ): SizingBucket {
    const age = opportunity.signal.timeSinceLaunchSec;

    // Recovery mode: when regime is STRESS, use recovery bucket for everything
    if (regime.regime === MarketRegime.STRESS) {
      return SizingBucket.RECOVERY_MODE;
    }

    // Normal bucket classification by age
    if (age <= 2) return SizingBucket.ULTRA_FAST_SNIPE;
    if (age <= 6) return SizingBucket.FAST_REACT;
    if (age <= 15) return SizingBucket.LATE_MOMENTUM;
    return SizingBucket.LATE_MOMENTUM;
  }

  private getRegimeMultiplier(regime: RegimeSnapshot): number {
    switch (regime.regime) {
      case MarketRegime.ACCELERATING:
        return 1.4;
      case MarketRegime.NORMAL:
        return 1.0;
      case MarketRegime.FRAGILE:
        return 0.55;
      case MarketRegime.STRESS:
        return 0.25;
      default:
        return 1.0;
    }
  }

  private computeDrawdownFactor(currentDrawdownPct: number): number {
    const { drawdownScaleStartPct, drawdownScaleFullPct, drawdownMinFactor } = this.config;

    if (currentDrawdownPct <= drawdownScaleStartPct) return 1.0;
    if (currentDrawdownPct >= drawdownScaleFullPct) return drawdownMinFactor;

    // Linear interpolation between 1.0 and drawdownMinFactor
    const range = drawdownScaleFullPct - drawdownScaleStartPct;
    const progress = (currentDrawdownPct - drawdownScaleStartPct) / range;
    return 1.0 - progress * (1.0 - drawdownMinFactor);
  }

  private recordCompositeRank(rank: number): void {
    this.recentCompositeRanks.push(rank);
    if (this.recentCompositeRanks.length > this.maxRankHistory) {
      this.recentCompositeRanks.shift();
    }
  }

  private isTopDecile(rank: number): boolean {
    if (this.recentCompositeRanks.length < 10) return false;
    const threshold = this.getTopDecileThresholdValue();
    return rank >= threshold;
  }

  private getTopDecileThresholdValue(): number {
    if (this.recentCompositeRanks.length < 10) return Infinity;
    const sorted = [...this.recentCompositeRanks].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * this.config.topDecileThreshold);
    return sorted[Math.min(idx, sorted.length - 1)];
  }
}
