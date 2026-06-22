/**
 * engine/pipeline.ts
 *
 * Main pipeline orchestrator that wires together:
 *   TokenSignals → HardFilter → OpportunityRanker → RegimeDetector →
 *   DynamicSizer → ExecutionRouter → FeedbackLoop → Retrain
 *
 * This is the primary entry point for processing token signals
 * at high throughput with full risk management and feedback.
 */

import {
  TokenSignal,
  PipelineDecision,
  ExecutionOrder,
  TradePosition,
  TradeOutcome,
  MarketRegime,
  SizingBucket,
  RiskConfig,
} from './types';
import { HardFilter, HardFilterConfig } from './hard-filter';
import { MLOpportunityRanker, MLRankerConfig } from './ml-ranker';
import { TradingRegimeDetector, RegimeDetectorConfig } from './regime-detector';
import { DynamicSizer, DynamicSizerConfig } from './dynamic-sizer';
import { RiskManager } from './risk-manager';
import { ExecutionRouter, ExecutionRouterConfig } from './execution-router';
import { FeedbackLoop, FeedbackLoopConfig } from './feedback-loop';

// ─── Pipeline Configuration ─────────────────────────────────────────

export interface PipelineConfig {
  hardFilter?: Partial<HardFilterConfig>;
  mlRanker?: Partial<MLRankerConfig>;
  regimeDetector?: Partial<RegimeDetectorConfig>;
  dynamicSizer?: Partial<DynamicSizerConfig>;
  riskManager?: Partial<RiskConfig>;
  executionRouter?: Partial<ExecutionRouterConfig>;
  feedbackLoop?: Partial<FeedbackLoopConfig>;
  /** Maximum default slippage tolerance */
  maxSlippagePct: number;
  /** Maximum order deadline (ms from now) */
  orderDeadlineMs: number;
  /** Log decisions to console */
  verbose: boolean;
}

const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  maxSlippagePct: 0.15,
  orderDeadlineMs: 5000,
  verbose: false,
};

// ─── Pipeline ────────────────────────────────────────────────────────

export class TradingPipeline {
  readonly hardFilter: HardFilter;
  readonly mlRanker: MLOpportunityRanker;
  readonly regimeDetector: TradingRegimeDetector;
  readonly dynamicSizer: DynamicSizer;
  readonly riskManager: RiskManager;
  readonly executionRouter: ExecutionRouter;
  readonly feedbackLoop: FeedbackLoop;

  private readonly config: PipelineConfig;

  // Counters
  private totalSignals = 0;
  private totalFiltered = 0;
  private totalRanked = 0;
  private totalSized = 0;
  private totalExecuted = 0;
  private totalFilled = 0;

  // Timing
  private startTime = Date.now();

  constructor(config?: Partial<PipelineConfig>) {
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };

    this.hardFilter = new HardFilter(this.config.hardFilter);
    this.mlRanker = new MLOpportunityRanker(this.config.mlRanker);
    this.regimeDetector = new TradingRegimeDetector(this.config.regimeDetector);
    this.dynamicSizer = new DynamicSizer(this.config.dynamicSizer);
    this.riskManager = new RiskManager(this.config.riskManager);
    this.executionRouter = new ExecutionRouter(this.config.executionRouter);
    this.feedbackLoop = new FeedbackLoop(this.config.feedbackLoop);
  }

  /**
   * Process a single token signal through the full pipeline.
   * Returns the decision at whatever stage it stops.
   */
  async processSignal(signal: TokenSignal): Promise<PipelineDecision> {
    const startMs = Date.now();
    this.totalSignals++;

    // ── Stage 1: Hard Filter ──
    const hardFilter = await this.hardFilter.evaluate(signal);

    if (!hardFilter.passed) {
      this.totalFiltered++;
      const regime = this.regimeDetector.detect();
      return {
        signal,
        hardFilter,
        prediction: null,
        ranked: null,
        regime,
        sizing: null,
        risk: {
          approved: false,
          cappedSizeSol: 0,
          reason: `hard_filter: ${hardFilter.reasons.join(', ')}`,
          riskMode: this.riskManager.getState().riskMode,
          currentDrawdownPct: this.riskManager.getState().dailyDrawdownPct,
          openExposurePct: 0,
          tokenExposurePct: 0,
        },
        order: null,
        execution: null,
        stage: 'HARD_FILTER',
        decisionTimestamp: Date.now(),
        totalLatencyMs: Date.now() - startMs,
      };
    }

    // ── Stage 2: ML Ranking ──
    const regime = this.regimeDetector.detect();
    const rankedBatch = this.mlRanker.rankBatch(
      [{ signal, hardFilter }],
      regime,
    );

    if (rankedBatch.length === 0) {
      return {
        signal,
        hardFilter,
        prediction: null,
        ranked: null,
        regime,
        sizing: null,
        risk: {
          approved: false,
          cappedSizeSol: 0,
          reason: 'ml_rank: below_threshold',
          riskMode: this.riskManager.getState().riskMode,
          currentDrawdownPct: this.riskManager.getState().dailyDrawdownPct,
          openExposurePct: 0,
          tokenExposurePct: 0,
        },
        order: null,
        execution: null,
        stage: 'ML_RANK',
        decisionTimestamp: Date.now(),
        totalLatencyMs: Date.now() - startMs,
      };
    }

    const ranked = rankedBatch[0];
    this.totalRanked++;

    // ── Stage 3: Dynamic Sizing ──
    const riskState = this.riskManager.getState();
    const equity = this.riskManager.getCurrentEquity();
    const openExposurePct = equity > 0
      ? (this.riskManager.getOpenExposureSol() / equity) * 100
      : 0;

    const sizing = this.dynamicSizer.size({
      opportunity: ranked,
      regime,
      currentEquity: equity,
      currentDrawdownPct: riskState.dailyDrawdownPct,
      openExposurePct,
      openPositionCount: riskState.openPositions.length,
    });

    if (!sizing) {
      return {
        signal,
        hardFilter,
        prediction: ranked.prediction,
        ranked,
        regime,
        sizing: null,
        risk: {
          approved: false,
          cappedSizeSol: 0,
          reason: 'sizing: below_minimum_or_exposure_cap',
          riskMode: riskState.riskMode,
          currentDrawdownPct: riskState.dailyDrawdownPct,
          openExposurePct,
          tokenExposurePct: 0,
        },
        order: null,
        execution: null,
        stage: 'DYNAMIC_SIZE',
        decisionTimestamp: Date.now(),
        totalLatencyMs: Date.now() - startMs,
      };
    }
    this.totalSized++;

    // ── Stage 4: Risk Assessment ──
    const order: ExecutionOrder = {
      mint: signal.mint,
      action: 'BUY',
      sizeSol: sizing.positionSizeSol,
      bucket: sizing.bucket,
      regime: regime.regime,
      mlScore: ranked.prediction.confidence,
      expectedEdge: ranked.expectedEdge,
      priority: Math.round((1 - ranked.compositeRank) * 100),
      maxSlippagePct: this.config.maxSlippagePct,
      deadlineMs: Date.now() + this.config.orderDeadlineMs,
    };

    const riskAssessment = this.riskManager.assess(order, regime);

    if (!riskAssessment.approved) {
      return {
        signal,
        hardFilter,
        prediction: ranked.prediction,
        ranked,
        regime,
        sizing,
        risk: riskAssessment,
        order: null,
        execution: null,
        stage: 'EXECUTION',
        decisionTimestamp: Date.now(),
        totalLatencyMs: Date.now() - startMs,
      };
    }

    // ── Stage 5: Execute ──
    const cappedOrder: ExecutionOrder = {
      ...order,
      sizeSol: riskAssessment.cappedSizeSol,
    };

    const executionResult = await this.executionRouter.execute(cappedOrder);
    this.totalExecuted++;

    // Track fill attempt in regime detector
    this.regimeDetector.recordFillAttempt(executionResult.filled);

    if (executionResult.filled) {
      this.totalFilled++;

      // Record position in risk manager
      const position: TradePosition = {
        mint: signal.mint,
        bucket: sizing.bucket,
        entrySizeSol: executionResult.fillSizeSol,
        entryTimestamp: Date.now(),
        mlScore: ranked.prediction.confidence,
        regime: regime.regime,
      };
      this.riskManager.onTradeEntry(position);
    }

    return {
      signal,
      hardFilter,
      prediction: ranked.prediction,
      ranked,
      regime,
      sizing,
      risk: riskAssessment,
      order: cappedOrder,
      execution: executionResult,
      stage: 'EXECUTION',
      decisionTimestamp: Date.now(),
      totalLatencyMs: Date.now() - startMs,
    };
  }

  /**
   * Process a batch of signals through the pipeline.
   * Signals are first filtered, then ranked, then the best are sized/executed.
   */
  async processBatch(signals: TokenSignal[]): Promise<PipelineDecision[]> {
    const decisions: PipelineDecision[] = [];

    // Process each signal (could be parallelized further)
    for (const signal of signals) {
      const decision = await this.processSignal(signal);
      decisions.push(decision);
    }

    // Check if feedback loop needs retraining
    this.feedbackLoop.maybeRetrain(this.hardFilter, this.mlRanker);

    return decisions;
  }

  /**
   * Record a trade entry (position opened).
   */
  recordTradeEntry(position: TradePosition): void {
    this.riskManager.onTradeEntry(position);
  }

  /**
   * Record a trade exit (for feedback and risk tracking).
   * Alias for recordTradeExit for clarity.
   */
  recordOutcome(outcome: TradeOutcome): void {
    this.recordTradeExit(outcome);
  }

  /**
   * Record a trade exit (for feedback and risk tracking).
   */
  recordTradeExit(outcome: TradeOutcome): void {
    // Update risk manager
    this.riskManager.onTradeExit(outcome);

    // Update regime detector
    this.regimeDetector.recordOutcome(outcome);

    // Record in feedback loop
    const regime = this.regimeDetector.detect();
    this.feedbackLoop.record(
      outcome,
      regime, // regime at entry would ideally be stored; using current as approximation
      regime,
      { passed: true, score: 0, reasons: [], latencyMs: 0, isCriticalReject: false },
      {
        expectedReturn: outcome.expectedEdgeAtEntry,
        rugProbability: 0,
        volatilityAdjustedEdge: outcome.expectedEdgeAtEntry,
        confidence: outcome.mlScoreAtEntry,
      },
    );
  }

  /**
   * Get comprehensive pipeline statistics.
   */
  getStats(): Record<string, unknown> {
    const uptime = Date.now() - this.startTime;
    const uptimeHours = uptime / (1000 * 60 * 60);

    return {
      uptime: `${uptimeHours.toFixed(2)}h`,
      totalSignals: this.totalSignals,
      totalFiltered: this.totalFiltered,
      totalRanked: this.totalRanked,
      totalSized: this.totalSized,
      totalExecuted: this.totalExecuted,
      totalFilled: this.totalFilled,
      signalsPerHour: uptimeHours > 0 ? this.totalSignals / uptimeHours : 0,
      tradesPerHour: uptimeHours > 0 ? this.totalFilled / uptimeHours : 0,
      filterPassRate: this.totalSignals > 0 ? (this.totalSignals - this.totalFiltered) / this.totalSignals : 0,
      fillRate: this.totalExecuted > 0 ? this.totalFilled / this.totalExecuted : 0,
      hardFilter: this.hardFilter.getStats(),
      mlRanker: this.mlRanker.getStats(),
      dynamicSizer: this.dynamicSizer.getStats(),
      riskManager: this.riskManager.getStats(),
      executionRouter: this.executionRouter.getStats(),
      feedbackLoop: this.feedbackLoop.getAnalytics(),
    };
  }

  /**
   * Reset pipeline state (for scenario testing).
   */
  reset(): void {
    this.totalSignals = 0;
    this.totalFiltered = 0;
    this.totalRanked = 0;
    this.totalSized = 0;
    this.totalExecuted = 0;
    this.totalFilled = 0;
    this.startTime = Date.now();
  }
}
