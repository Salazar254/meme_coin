/**
 * engine/risk-manager.ts
 *
 * Production risk manager for aggressive daily scaling without catastrophic loss.
 *
 * Features:
 *   - Per-trade risk caps
 *   - Per-token exposure caps
 *   - Daily and rolling drawdown limits
 *   - Concurrency limits
 *   - Survival mode (automatic regime-driven tightening)
 *   - Live kill-switches (with manual override)
 */

import {
  RiskConfig,
  RiskAssessment,
  RiskState,
  TradePosition,
  ExecutionOrder,
  TradeOutcome,
  SizingBucket,
  MarketRegime,
  RegimeSnapshot,
} from './types';

// ─── Default Configuration ───────────────────────────────────────────

const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxRiskPerTradePct: 0.5,
  maxTokenExposurePct: 9.0,
  maxTotalExposurePct: 18.0,
  maxConcurrentTrades: 350,
  dailyDrawdownLimitPct: 35.0,
  rollingDrawdownLimitPct: 45.0,
  maxPositionSol: 2.0,
  initialBankrollSol: 10.0,
  survivalSharpeThreshold: -0.2,
  survivalConsecutiveLosses: 8,
};

// ─── Survival Mode Caps ──────────────────────────────────────────────

interface ModeCaps {
  maxRiskPerTradePct: number;
  maxTotalExposurePct: number;
  maxTokenExposurePct: number;
  maxPositionSol: number;
  maxConcurrentTrades: number;
  mlScoreMultiplier: number;
  minMlScoreFloor: number;
}

const NORMAL_CAPS = (config: RiskConfig): ModeCaps => ({
  maxRiskPerTradePct: config.maxRiskPerTradePct,
  maxTotalExposurePct: config.maxTotalExposurePct,
  maxTokenExposurePct: config.maxTokenExposurePct,
  maxPositionSol: config.maxPositionSol,
  maxConcurrentTrades: config.maxConcurrentTrades,
  mlScoreMultiplier: 1.0,
  minMlScoreFloor: 0.0,
});

const SURVIVAL_CAPS = (config: RiskConfig): ModeCaps => ({
  maxRiskPerTradePct: config.maxRiskPerTradePct * 0.5,
  maxTotalExposurePct: config.maxTotalExposurePct * 0.6,
  maxTokenExposurePct: config.maxTokenExposurePct * 0.6,
  maxPositionSol: config.maxPositionSol * 0.6,
  maxConcurrentTrades: Math.floor(config.maxConcurrentTrades * 0.6),
  mlScoreMultiplier: 0.8,
  minMlScoreFloor: 0.6,
});

// ─── Risk Manager ────────────────────────────────────────────────────

export class RiskManager {
  private readonly config: RiskConfig;
  private state: RiskState;
  private activeCaps: ModeCaps;

  // Kill switch overrides
  private manualKillSwitch = false;
  private manualKillSwitchReason = '';

  // Rolling Sharpe window
  private readonly rollingPnlWindow: number[] = [];
  private readonly rollingWindowSize = 30;

  constructor(config?: Partial<RiskConfig>) {
    this.config = { ...DEFAULT_RISK_CONFIG, ...config };
    this.activeCaps = NORMAL_CAPS(this.config);

    this.state = {
      bankrollSol: this.config.initialBankrollSol,
      currentEquity: this.config.initialBankrollSol,
      peakEquity: this.config.initialBankrollSol,
      dayPeakEquity: this.config.initialBankrollSol,
      totalPnlSol: 0,
      maxDrawdownPct: 0,
      dailyDrawdownPct: 0,
      openPositions: [],
      tokenExposure: new Map(),
      killSwitchTriggered: false,
      riskMode: 'NORMAL',
      tradesBlocked: 0,
      consecutiveLosses: 0,
      dailyPnls: [],
    };
  }

  /**
   * Assess whether a proposed trade is allowed under current risk limits.
   * Caps the size down if needed, or rejects entirely.
   */
  assess(order: ExecutionOrder, regime: RegimeSnapshot): RiskAssessment {
    // Kill switch check
    if (this.state.killSwitchTriggered || this.manualKillSwitch) {
      return this.reject(
        order,
        `kill_switch: ${this.manualKillSwitch ? this.manualKillSwitchReason : 'daily_drawdown_limit'}`,
        'KILL_SWITCH',
      );
    }

    // Concurrency check
    if (this.state.openPositions.length >= this.activeCaps.maxConcurrentTrades) {
      return this.reject(order, `concurrency_cap (${this.activeCaps.maxConcurrentTrades})`, this.state.riskMode);
    }

    // ML score floor (survival mode)
    if (order.mlScore * this.activeCaps.mlScoreMultiplier < this.activeCaps.minMlScoreFloor && this.state.riskMode !== 'DATA_ONLY') {
      return this.reject(
        order,
        `ml_score_floor (${order.mlScore.toFixed(3)} * ${this.activeCaps.mlScoreMultiplier} < ${this.activeCaps.minMlScoreFloor})`,
        this.state.riskMode,
      );
    }

    // DATA_ONLY mode check
    if (this.state.riskMode === 'DATA_ONLY') {
      return this.reject(order, 'data_only_mode: monitoring regime recovery', 'DATA_ONLY');
    }

    const currentEquity = this.getCurrentEquity();
    const openExposureSol = this.getOpenExposureSol();
    const openExposurePct = currentEquity > 0 ? (openExposureSol / currentEquity) * 100 : 100;
    const tokenExposureSol = this.state.tokenExposure.get(order.mint) ?? 0;
    const tokenExposurePct = currentEquity > 0 ? (tokenExposureSol / currentEquity) * 100 : 0;

    // Compute caps
    const maxByRisk = currentEquity * (this.activeCaps.maxRiskPerTradePct / 100);
    const maxByTotalExposure = currentEquity * (this.activeCaps.maxTotalExposurePct / 100) - openExposureSol;
    const maxByTokenExposure = currentEquity * (this.activeCaps.maxTokenExposurePct / 100) - tokenExposureSol;
    const maxByAbsolute = this.activeCaps.maxPositionSol;
    const maxByBankroll = Math.max(this.state.bankrollSol * 0.5, 0);

    let cappedSize = Math.min(
      order.sizeSol,
      maxByRisk,
      Math.max(0, maxByTotalExposure),
      Math.max(0, maxByTokenExposure),
      maxByAbsolute,
      maxByBankroll,
    );
    cappedSize = Math.max(0, cappedSize);

    if (cappedSize < 0.001) {
      return this.reject(
        order,
        `risk_limit: req=${order.sizeSol.toFixed(4)} max_risk=${maxByRisk.toFixed(4)} max_total=${Math.max(0, maxByTotalExposure).toFixed(4)} max_token=${Math.max(0, maxByTokenExposure).toFixed(4)}`,
        this.state.riskMode,
      );
    }

    return {
      approved: true,
      cappedSizeSol: cappedSize,
      reason: cappedSize < order.sizeSol
        ? `capped from ${order.sizeSol.toFixed(4)} to ${cappedSize.toFixed(4)}`
        : 'approved',
      riskMode: this.state.riskMode,
      currentDrawdownPct: this.state.dailyDrawdownPct,
      openExposurePct,
      tokenExposurePct,
    };
  }

  /**
   * Record trade entry into risk state.
   */
  onTradeEntry(position: TradePosition): void {
    this.state.openPositions.push(position);
    this.state.bankrollSol -= position.entrySizeSol;
    this.state.tokenExposure.set(
      position.mint,
      (this.state.tokenExposure.get(position.mint) ?? 0) + position.entrySizeSol,
    );
    this.updateDrawdown();
  }

  /**
   * Record trade exit and update P&L.
   */
  onTradeExit(outcome: TradeOutcome): void {
    this.state.bankrollSol += outcome.entrySizeSol + outcome.pnlSol;
    this.state.totalPnlSol += outcome.pnlSol;

    // Update token exposure
    const currentExposure = this.state.tokenExposure.get(outcome.mint) ?? 0;
    const newExposure = Math.max(0, currentExposure - outcome.entrySizeSol);
    if (newExposure > 0) {
      this.state.tokenExposure.set(outcome.mint, newExposure);
    } else {
      this.state.tokenExposure.delete(outcome.mint);
    }

    // Remove position
    const idx = this.state.openPositions.findIndex(
      (p) => p.mint === outcome.mint && Math.abs(p.entrySizeSol - outcome.entrySizeSol) < 1e-10,
    );
    if (idx >= 0) {
      this.state.openPositions.splice(idx, 1);
    }

    // Track consecutive losses
    if (outcome.pnlSol < 0) {
      this.state.consecutiveLosses++;
    } else {
      this.state.consecutiveLosses = 0;
    }

    this.updateDrawdown();
    this.maybeEnableSurvivalMode();
  }

  /**
   * Record end-of-day P&L for rolling metrics.
   */
  recordDailyPnl(pnlSol: number): void {
    this.state.dailyPnls.push(pnlSol);
    this.rollingPnlWindow.push(pnlSol);
    while (this.rollingPnlWindow.length > this.rollingWindowSize) {
      this.rollingPnlWindow.shift();
    }
    // Reset day peak
    this.state.dayPeakEquity = this.getCurrentEquity();
  }

  /**
   * Manually trigger or release kill switch.
   */
  setKillSwitch(active: boolean, reason = 'manual'): void {
    this.manualKillSwitch = active;
    this.manualKillSwitchReason = reason;
    if (!active) {
      // Also clear the auto kill switch
      this.state.killSwitchTriggered = false;
    }
  }

  /**
   * Force mode change.
   */
  setMode(mode: 'NORMAL' | 'SURVIVAL' | 'DATA_ONLY'): void {
    this.state.riskMode = mode;
    if (mode === 'SURVIVAL') {
      this.activeCaps = SURVIVAL_CAPS(this.config);
    } else if (mode === 'DATA_ONLY') {
      this.activeCaps = SURVIVAL_CAPS(this.config); // Use survival caps as baseline
    } else {
      this.activeCaps = NORMAL_CAPS(this.config);
    }
  }

  /**
   * Auto-detect survival mode trigger.
   */
  maybeEnableSurvivalMode(): void {
    const sharpe = this.computeRollingSharpe();
    if (
      (sharpe < this.config.survivalSharpeThreshold || this.state.consecutiveLosses >= this.config.survivalConsecutiveLosses) &&
      this.state.riskMode !== 'SURVIVAL'
    ) {
      this.setMode('SURVIVAL');
    } else if (
      sharpe > 0.5 &&
      this.state.consecutiveLosses < 3 &&
      this.state.riskMode === 'SURVIVAL'
    ) {
      // Auto-recover from survival mode when conditions improve
      this.setMode('NORMAL');
    }
  }

  // ── Getters ────────────────────────────────────────────────────────

  getCurrentEquity(): number {
    return this.state.bankrollSol + this.getOpenExposureSol();
  }

  getOpenExposureSol(): number {
    return this.state.openPositions.reduce((sum, p) => sum + p.entrySizeSol, 0);
  }

  getState(): Readonly<RiskState> {
    return { ...this.state };
  }

  getStats(): Record<string, unknown> {
    const equity = this.getCurrentEquity();
    return {
      currentEquity: equity,
      bankrollSol: this.state.bankrollSol,
      openExposureSol: this.getOpenExposureSol(),
      openExposurePct: equity > 0 ? (this.getOpenExposureSol() / equity) * 100 : 0,
      totalPnlSol: this.state.totalPnlSol,
      maxDrawdownPct: this.state.maxDrawdownPct,
      dailyDrawdownPct: this.state.dailyDrawdownPct,
      openPositionCount: this.state.openPositions.length,
      tradesBlocked: this.state.tradesBlocked,
      riskMode: this.state.riskMode,
      killSwitch: this.state.killSwitchTriggered || this.manualKillSwitch,
      consecutiveLosses: this.state.consecutiveLosses,
      rollingSharpe: this.computeRollingSharpe(),
    };
  }

  // ── Private ────────────────────────────────────────────────────────

  private reject(
    order: ExecutionOrder,
    reason: string,
    mode: 'NORMAL' | 'SURVIVAL' | 'DATA_ONLY' | 'KILL_SWITCH',
  ): RiskAssessment {
    this.state.tradesBlocked++;
    return {
      approved: false,
      cappedSizeSol: 0,
      reason,
      riskMode: mode,
      currentDrawdownPct: this.state.dailyDrawdownPct,
      openExposurePct: this.getCurrentEquity() > 0
        ? (this.getOpenExposureSol() / this.getCurrentEquity()) * 100
        : 100,
      tokenExposurePct: 0,
    };
  }

  private updateDrawdown(): void {
    const equity = this.getCurrentEquity();

    if (equity > this.state.peakEquity) {
      this.state.peakEquity = equity;
    }
    if (equity > this.state.dayPeakEquity) {
      this.state.dayPeakEquity = equity;
    }

    // Max drawdown
    if (this.state.peakEquity > 0) {
      this.state.maxDrawdownPct = Math.max(
        this.state.maxDrawdownPct,
        ((this.state.peakEquity - equity) / this.state.peakEquity) * 100,
      );
    }

    // Daily drawdown
    if (this.state.dayPeakEquity > 0) {
      this.state.dailyDrawdownPct =
        ((this.state.dayPeakEquity - equity) / this.state.dayPeakEquity) * 100;
    }

    // Kill switch
    if (this.state.dailyDrawdownPct >= this.config.dailyDrawdownLimitPct) {
      this.state.killSwitchTriggered = true;
    }

    // Rolling drawdown check
    if (this.state.maxDrawdownPct >= this.config.rollingDrawdownLimitPct) {
      this.state.riskMode = 'DATA_ONLY';
    }

    this.state.currentEquity = equity;
  }

  private computeRollingSharpe(): number {
    if (this.rollingPnlWindow.length < 3) return 0;
    const n = this.rollingPnlWindow.length;
    const mean = this.rollingPnlWindow.reduce((a, b) => a + b, 0) / n;
    const variance = this.rollingPnlWindow.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    if (std < 1e-10) return 0;
    return (mean / std) * Math.sqrt(30);
  }
}
