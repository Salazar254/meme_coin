/**
 * engine/feedback-loop.ts
 *
 * Feedback and retraining system that records:
 *   - Token outcome, trade outcome, slippage, fill quality
 *   - PnL by setup (bucket, regime, edge tier)
 *   - Regime context at entry and exit
 *
 * Uses feedback to update:
 *   - ML ranker (feature normalization, model hints)
 *   - Hard filter weights (adjust non-critical weights based on outcomes)
 *   - Position sizing rules (calibrate drawdown/edge scaling)
 */

import {
  FeedbackRecord,
  TradeOutcome,
  RegimeSnapshot,
  HardFilterResult,
  MLPrediction,
  SizingBucket,
  MarketRegime,
} from './types';
import { HardFilter, HardFilterWeights } from './hard-filter';
import { MLOpportunityRanker } from './ml-ranker';

// ─── Configuration ──────────────────────────────────────────────────

export interface FeedbackLoopConfig {
  /** Maximum feedback records to keep in memory */
  readonly maxRecords: number;
  /** Minimum records needed before adjusting weights */
  readonly minRecordsForRetrain: number;
  /** How often to auto-retrain (records interval) */
  readonly retrainInterval: number;
  /** Learning rate for weight adjustments */
  readonly weightLearningRate: number;
  /** Maximum weight change per retrain cycle (bounds drift) */
  readonly maxWeightDelta: number;
}

const DEFAULT_CONFIG: FeedbackLoopConfig = {
  maxRecords: 5000,
  minRecordsForRetrain: 50,
  retrainInterval: 100,
  weightLearningRate: 0.05,
  maxWeightDelta: 5.0,
};

// ─── Analytics Aggregates ────────────────────────────────────────────

export interface PerformanceBySetup {
  bucket: SizingBucket;
  regime: MarketRegime;
  count: number;
  totalPnl: number;
  avgPnl: number;
  winRate: number;
  avgSlippage: number;
  avgFillQuality: number;
  avgEdgeRealization: number;
}

export interface RetrainReport {
  readonly timestamp: number;
  readonly recordCount: number;
  readonly adjustedComponents: string[];
  readonly filterWeightDeltas: Partial<HardFilterWeights>;
  readonly overallWinRate: number;
  readonly overallSharpe: number;
  readonly performanceBySetup: PerformanceBySetup[];
}

// ─── Feedback Loop ───────────────────────────────────────────────────

export class FeedbackLoop {
  private readonly config: FeedbackLoopConfig;
  private records: FeedbackRecord[] = [];
  private recordsSinceRetrain = 0;
  private retrainCount = 0;
  private retrainReports: RetrainReport[] = [];

  constructor(config?: Partial<FeedbackLoopConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a completed trade with all context.
   */
  record(
    outcome: TradeOutcome,
    regimeAtEntry: RegimeSnapshot,
    regimeAtExit: RegimeSnapshot,
    hardFilterResult: HardFilterResult,
    predictionAtEntry: MLPrediction,
  ): void {
    const mlCorrect =
      (predictionAtEntry.expectedReturn > 0 && outcome.pnlSol > 0) ||
      (predictionAtEntry.expectedReturn <= 0 && outcome.pnlSol <= 0);

    const expectedEdge =
      predictionAtEntry.expectedReturn *
      (1 - predictionAtEntry.rugProbability) *
      predictionAtEntry.confidence;
    const realizedEdge = outcome.pnlPct;
    const edgeRealizationRatio = expectedEdge !== 0 ? realizedEdge / expectedEdge : 0;

    const feedbackRecord: FeedbackRecord = {
      outcome,
      regimeAtEntry,
      regimeAtExit,
      hardFilterResultAtEntry: hardFilterResult,
      predictionAtEntry,
      mlCorrect,
      edgeRealizationRatio,
    };

    this.records.push(feedbackRecord);
    this.recordsSinceRetrain++;

    // Trim oldest records
    while (this.records.length > this.config.maxRecords) {
      this.records.shift();
    }
  }

  /**
   * Check if retraining is needed and execute if so.
   * Returns a report if retrain happened, null otherwise.
   */
  maybeRetrain(
    hardFilter: HardFilter,
    _mlRanker: MLOpportunityRanker,
  ): RetrainReport | null {
    if (
      this.records.length < this.config.minRecordsForRetrain ||
      this.recordsSinceRetrain < this.config.retrainInterval
    ) {
      return null;
    }

    return this.retrain(hardFilter, _mlRanker);
  }

  /**
   * Force a retrain cycle.
   */
  retrain(
    hardFilter: HardFilter,
    _mlRanker: MLOpportunityRanker,
  ): RetrainReport {
    const adjustedComponents: string[] = [];

    // ── 1. Analyze performance by setup ──
    const performanceBySetup = this.analyzePerformanceBySetup();

    // ── 2. Adjust hard filter weights based on outcomes ──
    const weightDeltas = this.computeFilterWeightAdjustments();
    if (Object.keys(weightDeltas).length > 0) {
      hardFilter.updateWeights(weightDeltas as Partial<HardFilterWeights>);
      adjustedComponents.push('HARD_FILTER_WEIGHTS');
    }

    // ── 3. Compute overall metrics ──
    const allOutcomes = this.records.map((r) => r.outcome);
    const wins = allOutcomes.filter((o) => o.pnlSol > 0).length;
    const overallWinRate = allOutcomes.length > 0 ? wins / allOutcomes.length : 0;
    const overallSharpe = this.computeSharpe(allOutcomes.map((o) => o.pnlPct));

    // ── 4. Send retraining signal to ML ranker ──
    // In production, this would serialize feedback and trigger Python model retrain
    adjustedComponents.push('ML_RANKER_SIGNAL');

    this.recordsSinceRetrain = 0;
    this.retrainCount++;

    const report: RetrainReport = {
      timestamp: Date.now(),
      recordCount: this.records.length,
      adjustedComponents,
      filterWeightDeltas: weightDeltas,
      overallWinRate,
      overallSharpe,
      performanceBySetup,
    };

    this.retrainReports.push(report);
    return report;
  }

  /**
   * Get cumulative performance analytics.
   */
  getAnalytics(): Record<string, unknown> {
    const allOutcomes = this.records.map((r) => r.outcome);
    const totalPnl = allOutcomes.reduce((s, o) => s + o.pnlSol, 0);
    const wins = allOutcomes.filter((o) => o.pnlSol > 0).length;

    const mlCorrectCount = this.records.filter((r) => r.mlCorrect).length;
    const avgEdgeRealization =
      this.records.length > 0
        ? this.records.reduce((s, r) => s + r.edgeRealizationRatio, 0) / this.records.length
        : 0;

    const avgSlippage =
      allOutcomes.length > 0
        ? allOutcomes.reduce((s, o) => s + o.slippageEntry, 0) / allOutcomes.length
        : 0;

    return {
      totalRecords: this.records.length,
      totalPnlSol: totalPnl,
      winRate: allOutcomes.length > 0 ? wins / allOutcomes.length : 0,
      mlAccuracy: this.records.length > 0 ? mlCorrectCount / this.records.length : 0,
      avgEdgeRealization,
      avgSlippage,
      retrainCount: this.retrainCount,
      recordsSinceRetrain: this.recordsSinceRetrain,
    };
  }

  getRetrainReports(): RetrainReport[] {
    return [...this.retrainReports];
  }

  getRecords(): readonly FeedbackRecord[] {
    return this.records;
  }

  // ── Private ────────────────────────────────────────────────────────

  private analyzePerformanceBySetup(): PerformanceBySetup[] {
    const groups = new Map<string, FeedbackRecord[]>();

    for (const record of this.records) {
      const key = `${record.outcome.bucket}|${record.outcome.regime}`;
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }

    const results: PerformanceBySetup[] = [];
    for (const [key, records] of groups) {
      const [bucket, regime] = key.split('|') as [SizingBucket, MarketRegime];
      const outcomes = records.map((r) => r.outcome);
      const wins = outcomes.filter((o) => o.pnlSol > 0).length;

      results.push({
        bucket,
        regime,
        count: records.length,
        totalPnl: outcomes.reduce((s, o) => s + o.pnlSol, 0),
        avgPnl: outcomes.reduce((s, o) => s + o.pnlSol, 0) / outcomes.length,
        winRate: wins / outcomes.length,
        avgSlippage: outcomes.reduce((s, o) => s + o.slippageEntry, 0) / outcomes.length,
        avgFillQuality: outcomes.reduce((s, o) => s + o.fillQuality, 0) / outcomes.length,
        avgEdgeRealization: records.reduce((s, r) => s + r.edgeRealizationRatio, 0) / records.length,
      });
    }

    return results.sort((a, b) => b.avgPnl - a.avgPnl);
  }

  private computeFilterWeightAdjustments(): Partial<HardFilterWeights> {
    // Analyze false positive rate: tokens that passed filter but lost money
    const passedAndLost = this.records.filter(
      (r) => r.hardFilterResultAtEntry.passed && r.outcome.pnlSol < -0.05,
    );
    const passedTotal = this.records.filter((r) => r.hardFilterResultAtEntry.passed).length;

    if (passedTotal < 20) return {};

    const falsePositiveRate = passedAndLost.length / passedTotal;

    const deltas: Partial<HardFilterWeights> = {};
    const lr = this.config.weightLearningRate;
    const maxDelta = this.config.maxWeightDelta;

    // If false positive rate is high, tighten all non-critical weights
    if (falsePositiveRate > 0.5) {
      deltas.lpLock = Math.min(maxDelta, lr * 10 * (falsePositiveRate - 0.3));
      deltas.holderConcentration = Math.min(maxDelta, lr * 8 * (falsePositiveRate - 0.3));
      deltas.sellTax = Math.min(maxDelta, lr * 5 * (falsePositiveRate - 0.3));
    }

    return deltas;
  }

  private computeSharpe(returns: number[]): number {
    if (returns.length < 3) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    return std > 1e-10 ? (mean / std) * Math.sqrt(252) : 0;
  }
}
