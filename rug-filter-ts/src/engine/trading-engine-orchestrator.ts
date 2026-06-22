/**
 * engine/trading-engine-orchestrator.ts
 *
 * High-throughput memecoin trading engine orchestrator.
 * Coordinates the full pipeline with live execution, feedback, and retraining.
 *
 * Architecture:
 *   TokenSignals → HardFilter → MLRanker → RegimeDetector →
 *   DynamicSizer → RiskManager → ExecutionRouter → FeedbackLoop → Retrain
 */

import { EventEmitter } from 'events';
import pino from 'pino';

import {
  TokenSignal,
  PipelineDecision,
  TradeOutcome,
  DailySummary,
  MarketRegime,
  SizingBucket,
  TradePosition,
} from './types';
import { TradingPipeline, PipelineConfig } from './pipeline';
import { SummaryReportGenerator } from './summary-report';

export interface TradingEngineConfig extends PipelineConfig {
  /** Enable live execution (false = simulation) */
  liveExecution: boolean;
  /** Max consecutive trades per second */
  maxTradesPerSecond: number;
  /** Daily PnL target in SOL (for reporting) */
  dailyTargetSol: number;
  /** Reset daily limits at this UTC hour (0-23) */
  dailyResetHourUtc: number;
}

const DEFAULT_ENGINE_CONFIG: TradingEngineConfig = {
  liveExecution: false,
  maxTradesPerSecond: 10,
  dailyTargetSol: 5.0,
  dailyResetHourUtc: 0,
  maxSlippagePct: 0.15,
  orderDeadlineMs: 5000,
  verbose: false,
};

/**
 * Main trading engine orchestrator.
 * Provides high-level API for signal processing, execution, and reporting.
 */
export class TradingEngineOrchestrator extends EventEmitter {
  private readonly config: TradingEngineConfig;
  private readonly pipeline: TradingPipeline;
  private readonly logger: pino.Logger;

  // Daily state
  private dailyStartedAt = 0;
  private dailyCompletedTrades: TradeOutcome[] = [];
  private dailyGrossPnl = 0;
  private dailyNetPnl = 0;

  // Active trades
  private activeTrades: Map<string, { position: TradePosition; startedAt: number }> = new Map();

  // Throttling
  private lastTradeTimeMs = 0;
  private readonly tradeIntervalMs: number;

  // Stats
  private totalSignalsProcessed = 0;
  private totalTradesExecuted = 0;
  private totalOutcomes = 0;

  constructor(config?: Partial<TradingEngineConfig>, logger?: pino.Logger) {
    super();
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.pipeline = new TradingPipeline(config);
    this.logger = logger || pino({ level: 'info' });
    this.tradeIntervalMs = 1000 / this.config.maxTradesPerSecond;

    this.initializeDailyStats();
  }

  /**
   * Main entry point: process a token signal through the full pipeline.
   * Returns the decision and may execute a trade if approved.
   */
  async processSignal(signal: TokenSignal): Promise<PipelineDecision> {
    this.totalSignalsProcessed++;

    // Throttle to maintain max trades/sec
    await this.throttle();

    // Check if we need to reset daily stats
    this.checkDailyReset();

    try {
      const decision = await this.pipeline.processSignal(signal);

      // Emit decision event
      this.emit('decision', decision);

      // If an order was generated, track it
      if (decision.order) {
        this.totalTradesExecuted++;
      }

      return decision;
    } catch (err) {
      this.logger.error({ err, signal }, 'Pipeline error');
      this.emit('error', { error: err, signal });
      throw err;
    }
  }

  /**
   * Process a batch of token signals efficiently.
   */
  async processSignalBatch(signals: TokenSignal[]): Promise<PipelineDecision[]> {
    const results: PipelineDecision[] = [];

    for (const signal of signals) {
      try {
        const decision = await this.processSignal(signal);
        results.push(decision);
      } catch (err) {
        this.logger.warn({ err, mint: signal.mint }, 'Failed to process signal');
      }
    }

    return results;
  }

  /**
   * Record a completed trade outcome (after fill and exit).
   */
  recordTradeOutcome(outcome: TradeOutcome): void {
    this.totalOutcomes++;

    // Update daily stats
    this.dailyCompletedTrades.push(outcome);
    this.dailyGrossPnl += Math.max(0, outcome.pnlSol);
    this.dailyNetPnl += outcome.pnlSol;

    // Remove from active trades
    this.activeTrades.delete(outcome.mint);

    // Feed back to system
    this.pipeline.recordOutcome(outcome);

    // Emit outcome event
    this.emit('trade_outcome', outcome);

    this.logger.debug(
      { mint: outcome.mint, pnl: outcome.pnlSol, pnlPct: outcome.pnlPct },
      'Trade outcome recorded',
    );
  }

  /**
   * Mark a trade as active (after order execution).
   */
  recordTradeEntry(position: TradePosition): void {
    this.activeTrades.set(position.mint, {
      position,
      startedAt: Date.now(),
    });

    this.pipeline.recordTradeEntry(position);

    this.emit('trade_entry', position);
  }

  /**
   * Get current daily summary.
   */
  getDailySummary(): DailySummary {
    return SummaryReportGenerator.generateDailySummary(
      this.pipeline,
      this.dailyCompletedTrades,
      150, // Assume ~$150 per SOL
    );
  }

  /**
   * Get current engine stats.
   */
  getStats() {
    return {
      totalSignalsProcessed: this.totalSignalsProcessed,
      totalTradesExecuted: this.totalTradesExecuted,
      totalOutcomes: this.totalOutcomes,
      activeTrades: this.activeTrades.size,
      dailyNetPnl: this.dailyNetPnl,
      dailyGrossPnl: this.dailyGrossPnl,
      dailyTradeCount: this.dailyCompletedTrades.length,
      riskState: this.pipeline.riskManager.getStats(),
      regimeState: {
        regime: this.pipeline.regimeDetector.getCurrentRegime(),
        history: this.pipeline.regimeDetector.getRegimeHistory(),
      },
      pipelineStats: {
        hardFilter: this.pipeline.hardFilter.getStats(),
        mlRanker: this.pipeline.mlRanker.getStats(),
        executionRouter: this.pipeline.executionRouter.getStats(),
      },
    };
  }

  /**
   * Manually trigger kill switch.
   */
  killSwitch(reason = 'manual'): void {
    this.pipeline.riskManager.setKillSwitch(true, reason);
    this.emit('kill_switch', { reason, timestamp: Date.now() });
    this.logger.warn({ reason }, 'Kill switch triggered');
  }

  /**
   * Release kill switch.
   */
  resumeTrading(): void {
    this.pipeline.riskManager.setKillSwitch(false);
    this.emit('resume_trading', { timestamp: Date.now() });
    this.logger.info('Trading resumed');
  }

  /**
   * Set risk mode (NORMAL or SURVIVAL).
   */
  setRiskMode(mode: 'NORMAL' | 'SURVIVAL'): void {
    this.pipeline.riskManager.setMode(mode);
    this.emit('risk_mode_changed', { mode, timestamp: Date.now() });
    this.logger.info({ mode }, 'Risk mode changed');
  }

  /**
   * Get pipeline instance for direct access.
   */
  getPipeline(): TradingPipeline {
    return this.pipeline;
  }

  // ── Private ────────────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastTradeTimeMs;
    if (elapsed < this.tradeIntervalMs) {
      await new Promise((r) => setTimeout(r, this.tradeIntervalMs - elapsed));
    }
    this.lastTradeTimeMs = Date.now();
  }

  private initializeDailyStats(): void {
    this.dailyStartedAt = Date.now();
    this.dailyCompletedTrades = [];
    this.dailyGrossPnl = 0;
    this.dailyNetPnl = 0;
  }

  private checkDailyReset(): void {
    const now = new Date();
    const currentHour = now.getUTCHours();

    // Check if we've crossed into a new day at reset hour
    const dayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${this.config.dailyResetHourUtc}`;
    if (!this.lastDayKey || this.lastDayKey !== dayKey) {
      if (currentHour === this.config.dailyResetHourUtc) {
        this.resetDaily();
      }
    }
    this.lastDayKey = dayKey;
  }

  private resetDaily(): void {
    const summary = this.getDailySummary();
    this.emit('daily_summary', summary);
    this.logger.info(
      { summary },
      `Daily summary (${this.dailyCompletedTrades.length} trades, ${this.dailyNetPnl.toFixed(4)} SOL)`,
    );

    this.initializeDailyStats();
  }

  private lastDayKey = '';
}
