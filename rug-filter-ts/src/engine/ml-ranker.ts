/**
 * engine/ml-ranker.ts
 *
 * Multi-target ML opportunity ranker.
 * Replaces simple classification with a multi-target prediction:
 *   - Short-horizon expected return
 *   - Rug probability
 *   - Volatility-adjusted edge
 *   - Prediction confidence
 *
 * Computes: expectedEdge = expectedReturn * (1 - rugProbability) * confidence
 * Ranks by: expected edge, liquidity quality, launch freshness, regime fit.
 */

import {
  TokenSignal,
  MLPrediction,
  RankedOpportunity,
  HardFilterResult,
  RegimeSnapshot,
  MarketRegime,
} from './types';

// ─── Configuration ──────────────────────────────────────────────────

export interface MLRankerConfig {
  /** Minimum confidence to consider a prediction valid */
  readonly minConfidence: number;
  /** Minimum expected edge to rank (below = skip) */
  readonly minExpectedEdge: number;
  /** Feature normalization means (loaded from training) */
  featureMeans: Float64Array | number[];
  /** Feature normalization stds (loaded from training) */
  featureStds: Float64Array | number[];
  /** Weights for composite rank scoring */
  readonly rankWeights: Readonly<RankWeights>;
  /** Maximum batch size for inference */
  readonly maxBatchSize: number;
}

export interface RankWeights {
  expectedEdge: number;
  liquidityQuality: number;
  launchFreshness: number;
  regimeFit: number;
}

const DEFAULT_RANK_WEIGHTS: RankWeights = {
  expectedEdge: 0.45,
  liquidityQuality: 0.20,
  launchFreshness: 0.15,
  regimeFit: 0.20,
};

// ─── Feature Extraction ──────────────────────────────────────────────

const NUM_FEATURES = 18;

function extractFeatures(signal: TokenSignal): number[] {
  return [
    signal.liquiditySol,
    signal.liquidityUsd,
    signal.uniqueBuyers,
    signal.totalVolume,
    signal.marketCapSol,
    signal.timeSinceLaunchSec,
    signal.slippageEstimate,
    signal.priceGrowth1s,
    signal.socialProxy1s,
    signal.lpGrowth1s,
    signal.buyersPerSol,
    signal.volumeToLpRatio,
    signal.logLiquidity,
    signal.logVolume,
    signal.logMcap,
    signal.hourOfDay,
    signal.dayOfWeek,
    signal.isWeekend ? 1.0 : 0.0,
  ];
}

function normalizeFeatures(
  features: number[],
  means: number[] | Float64Array,
  stds: number[] | Float64Array,
  clipStd = 5.0,
): number[] {
  return features.map((val, i) => {
    const std = stds[i] < 1e-6 ? 1.0 : stds[i];
    const normalized = (val - means[i]) / std;
    return Math.max(-clipStd, Math.min(clipStd, normalized));
  });
}

// ─── Lightweight MLP Inference ───────────────────────────────────────
// In production, this calls the Python model server via HTTP.
// This TypeScript implementation provides a fast fallback / warm-start.

interface MLPWeights {
  layers: Array<{
    weights: number[][];  // [output_dim][input_dim]
    biases: number[];
  }>;
}

function mlpForward(input: number[], weights: MLPWeights): number[] {
  let current = input;
  for (let i = 0; i < weights.layers.length; i++) {
    const layer = weights.layers[i];
    const output: number[] = new Array(layer.biases.length);
    for (let j = 0; j < layer.biases.length; j++) {
      let sum = layer.biases[j];
      for (let k = 0; k < current.length; k++) {
        sum += layer.weights[j][k] * current[k];
      }
      output[j] = sum;
    }
    // Apply ReLU for all layers except the last
    if (i < weights.layers.length - 1) {
      for (let j = 0; j < output.length; j++) {
        output[j] = Math.max(0, output[j]);
      }
    }
    current = output;
  }
  return current;
}

// ─── ML Ranker ───────────────────────────────────────────────────────

export class MLOpportunityRanker {
  private readonly config: MLRankerConfig;
  private modelWeights: MLPWeights | null = null;
  private totalRanked = 0;
  private totalSkipped = 0;

  constructor(config?: Partial<MLRankerConfig>) {
    this.config = {
      minConfidence: 0.3,
      minExpectedEdge: 0.001,
      featureMeans: new Array(NUM_FEATURES).fill(0),
      featureStds: new Array(NUM_FEATURES).fill(1),
      rankWeights: DEFAULT_RANK_WEIGHTS,
      maxBatchSize: 128,
      ...config,
    };
  }

  /**
   * Load pre-trained weights for the TypeScript fast-path MLP.
   * In production, this is populated from the Python model export.
   */
  loadWeights(weights: MLPWeights): void {
    this.modelWeights = weights;
  }

  /**
   * Load feature normalization stats from training.
   */
  loadNormalizationStats(means: number[], stds: number[]): void {
    this.config.featureMeans = means;
    this.config.featureStds = stds;
  }

  /**
   * Generate a multi-target prediction for a single token.
   */
  predict(signal: TokenSignal): MLPrediction {
    const raw = extractFeatures(signal);
    const normalized = normalizeFeatures(raw, this.config.featureMeans, this.config.featureStds);

    if (this.modelWeights) {
      return this.modelPredict(normalized, signal);
    }
    return this.heuristicPredict(signal);
  }

  /**
   * Rank a batch of signals that have passed the hard filter.
   */
  rankBatch(
    signals: Array<{ signal: TokenSignal; hardFilter: HardFilterResult }>,
    regime: RegimeSnapshot,
  ): RankedOpportunity[] {
    const ranked: RankedOpportunity[] = [];

    for (const { signal, hardFilter } of signals) {
      // Double-check: never rank a critical reject
      if (hardFilter.isCriticalReject || !hardFilter.passed) {
        this.totalSkipped++;
        continue;
      }

      const prediction = this.predict(signal);

      // Compute expected edge
      const expectedEdge =
        prediction.expectedReturn *
        (1 - prediction.rugProbability) *
        prediction.confidence;

      if (expectedEdge < this.config.minExpectedEdge) {
        this.totalSkipped++;
        continue;
      }

      if (prediction.confidence < this.config.minConfidence) {
        this.totalSkipped++;
        continue;
      }

      // Compute sub-scores
      const liquidityQuality = this.scoreLiquidityQuality(signal);
      const launchFreshness = this.scoreLaunchFreshness(signal);
      const regimeFit = this.scoreRegimeFit(signal, regime);

      // Composite rank
      const w = this.config.rankWeights;
      const compositeRank =
        w.expectedEdge * sigmoid(expectedEdge * 10) +
        w.liquidityQuality * liquidityQuality +
        w.launchFreshness * launchFreshness +
        w.regimeFit * regimeFit;

      ranked.push({
        signal,
        hardFilter,
        prediction,
        expectedEdge,
        liquidityQuality,
        launchFreshness,
        regimeFit,
        compositeRank,
      });

      this.totalRanked++;
    }

    // Sort descending by composite rank
    ranked.sort((a, b) => b.compositeRank - a.compositeRank);
    return ranked;
  }

  getStats(): Record<string, unknown> {
    return {
      totalRanked: this.totalRanked,
      totalSkipped: this.totalSkipped,
      hasModelWeights: this.modelWeights !== null,
    };
  }

  // ── Private: Model Prediction ──────────────────────────────────────

  private modelPredict(normalized: number[], signal: TokenSignal): MLPrediction {
    const output = mlpForward(normalized, this.modelWeights!);

    // Output heads: [expectedReturn, rugProbability, volatilityEdge, rawConfidence]
    // The model outputs 4 values; map through appropriate activations
    const expectedReturn = output[0] ?? 0;                            // raw regression
    const rugProbability = sigmoid(output[1] ?? 0);                   // bounded 0-1
    const volatilityAdjustedEdge = output[2] ?? 0;                    // raw
    const confidence = sigmoid(output[3] ?? 0);                       // bounded 0-1

    return {
      expectedReturn,
      rugProbability: Math.max(0, Math.min(1, rugProbability)),
      volatilityAdjustedEdge,
      confidence: Math.max(0, Math.min(1, confidence)),
    };
  }

  /**
   * Lightweight heuristic prediction when no trained model is loaded.
   * Provides reasonable priors based on signal features.
   */
  private heuristicPredict(signal: TokenSignal): MLPrediction {
    // Expected return: based on liquidity, buyers, growth signals
    const lpSignal = sigmoid((signal.liquiditySol - 0.7) * 1.5);
    const buyerSignal = sigmoid((signal.uniqueBuyers - 6) / 3);
    const growthSignal = sigmoid(signal.priceGrowth1s * 3);
    const socialSignal = sigmoid(signal.socialProxy1s * 2);

    const expectedReturn =
      0.30 * lpSignal + 0.25 * buyerSignal + 0.30 * growthSignal + 0.15 * socialSignal - 0.35;

    // Rug probability: high holder concentration, no LP lock = danger
    let rugScore = 0;
    if (signal.top10HolderPct > 70) rugScore += 0.3;
    if (signal.devWalletPct > 20) rugScore += 0.2;
    if (!signal.lpLocked && !signal.lpBurned) rugScore += 0.2;
    if (signal.walletClusterScore > 0.6) rugScore += 0.15;
    if (signal.sellTax > 10) rugScore += 0.15;
    const rugProbability = Math.min(1, rugScore);

    // Volatility-adjusted edge
    const slippagePenalty = signal.slippageEstimate * 2;
    const volatilityAdjustedEdge = Math.max(0, expectedReturn - slippagePenalty);

    // Confidence: higher when we have more data points
    const dataQuality =
      (signal.uniqueBuyers > 3 ? 0.2 : 0) +
      (signal.liquiditySol > 1 ? 0.2 : 0) +
      (signal.totalVolume > 0 ? 0.15 : 0) +
      (signal.timeSinceLaunchSec < 10 ? 0.15 : 0.05) +
      (signal.slippageEstimate < 0.3 ? 0.15 : 0);
    const confidence = Math.min(1, Math.max(0.1, dataQuality + 0.15));

    return {
      expectedReturn,
      rugProbability,
      volatilityAdjustedEdge,
      confidence,
    };
  }

  // ── Private: Sub-Scores ────────────────────────────────────────────

  private scoreLiquidityQuality(signal: TokenSignal): number {
    // Higher liquidity = better quality, capped
    const lpScore = Math.min(1, signal.liquiditySol / 10);
    const volumeScore = Math.min(1, signal.totalVolume / 50);
    const slippageScore = 1 - Math.min(1, signal.slippageEstimate * 3);
    return 0.4 * lpScore + 0.3 * volumeScore + 0.3 * slippageScore;
  }

  private scoreLaunchFreshness(signal: TokenSignal): number {
    // Fresher = better (for sniping)
    if (signal.timeSinceLaunchSec <= 2) return 1.0;
    if (signal.timeSinceLaunchSec <= 5) return 0.8;
    if (signal.timeSinceLaunchSec <= 10) return 0.5;
    if (signal.timeSinceLaunchSec <= 30) return 0.2;
    return 0.05;
  }

  private scoreRegimeFit(signal: TokenSignal, regime: RegimeSnapshot): number {
    switch (regime.regime) {
      case MarketRegime.ACCELERATING:
        // In accelerating regime, favor fresh launches with strong growth
        return 0.3 + 0.4 * sigmoid(signal.priceGrowth1s * 5) + 0.3 * sigmoid(signal.socialProxy1s * 3);
      case MarketRegime.NORMAL:
        // Normal: balanced scoring
        return 0.5 + 0.25 * sigmoid(signal.priceGrowth1s * 3) + 0.25 * sigmoid(signal.lpGrowth1s * 2);
      case MarketRegime.FRAGILE:
        // Fragile: penalize risky signals
        return 0.3 + 0.4 * (1 - signal.slippageEstimate) + 0.3 * Math.min(1, signal.liquiditySol / 5);
      case MarketRegime.STRESS:
        // Stress: only high-quality signals
        return 0.1 + 0.5 * Math.min(1, signal.liquiditySol / 10) + 0.4 * (signal.uniqueBuyers > 10 ? 1 : 0.3);
      default:
        return 0.5;
    }
  }
}

// ─── Utilities ──────────────────────────────────────────────────────

function sigmoid(x: number): number {
  const clamped = Math.max(-10, Math.min(10, x));
  return 1 / (1 + Math.exp(-clamped));
}
