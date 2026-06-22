/**
 * src/components/regime-detector.ts
 *
 * Detects when the rug-pattern meta is shifting.
 * Tracks:
 *   - Rolling 48h miss rate (rugs that bypassed filter)
 *   - Per-signal predictive power decay (information gain)
 *   - Regime state transitions
 *
 * Triggers REGIME_SHIFT event if:
 *   - Miss rate increases > 15% vs prior week
 *   - Multiple signals show info-gain drop
 */

import { Logger } from 'pino';
import Database from 'better-sqlite3';
import { RegimeState, FeedbackRecord } from '../types';

export interface RegimeDetectorConfig {
  dbPath: string;
  missRateIncreaseThreshold: number; // 0.15 = 15%
  regimeCheckIntervalMs: number; // How often to re-evaluate
  informationGainDecayThreshold: number; // 0.2 = 20% decay
}

export interface SignalPredictiveInfo {
  signal: string;
  informationGain: number; // 0-1 (entropy reduction)
  isDecaying: boolean;
}

/**
 * Regime detector: monitors rug-pattern shifts
 */
export class RegimeDetector {
  private config: RegimeDetectorConfig;
  private logger: Logger;
  private db: Database.Database;
  private currentRegime: RegimeState;
  private lastRegimeCheckTime: number = 0;

  constructor(config: RegimeDetectorConfig, db: Database.Database, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.db = db;

    this.currentRegime = {
      currentRegime: 'STABLE',
      missRate48h: 0,
      missRatePriorWeek: 0,
      missRateIncrease: 0,
      decayingSignals: [],
      shiftDetected: false,
      confidenceInDetection: 0,
      suggestRetrain: false,
      lastSwitchTimestamp: Date.now(),
    };
  }

  /**
   * Evaluate regime shift.
   * Call periodically (e.g., every 1hr or on new labeled feedback).
   */
  async evaluate(): Promise<RegimeState> {
    const now = Date.now();

    // Throttle checks
    if (now - this.lastRegimeCheckTime < this.config.regimeCheckIntervalMs) {
      return this.currentRegime;
    }

    this.lastRegimeCheckTime = now;

    // Compute miss rates
    const missRate48h = await this.computeMissRate(48 * 60 * 60 * 1000);
    const missRatePriorWeek = await this.computeMissRate(7 * 24 * 60 * 60 * 1000);

    // Compute signal decay
    const decayingSignals = await this.computeSignalDecay();

    // Detect regime shift
    const missRateIncrease =
      missRatePriorWeek > 0 ? (missRate48h - missRatePriorWeek) / missRatePriorWeek : 0;

    const shiftDetected =
      missRateIncrease > this.config.missRateIncreaseThreshold ||
      decayingSignals.filter((s) => s.isDecaying).length >= 2;

    // Update regime state
    this.currentRegime = {
      currentRegime: shiftDetected ? 'SHIFTING' : 'STABLE',
      missRate48h,
      missRatePriorWeek,
      missRateIncrease,
      decayingSignals: decayingSignals.map((s) => ({
        signal: s.signal,
        informationGainDrop: 1 - s.informationGain,
        isDecaying: s.isDecaying,
      })),
      shiftDetected,
      confidenceInDetection: this.computeConfidence(
        missRateIncrease,
        decayingSignals,
      ),
      suggestRetrain: shiftDetected,
      lastSwitchTimestamp: shiftDetected ? now : this.currentRegime.lastSwitchTimestamp,
    };

    if (shiftDetected) {
      this.logger.warn({
        msg: 'Regime shift detected',
        missRateIncrease: missRateIncrease.toFixed(3),
        decayingSignalCount: decayingSignals.filter((s) => s.isDecaying).length,
        regime: this.currentRegime.currentRegime,
      });
    }

    return this.currentRegime;
  }

  /**
   * Get current regime state (cached)
   */
  getState(): RegimeState {
    return this.currentRegime;
  }

  /**
   * Compute miss rate: ratio of rugs that bypassed filter
   * Query: labeled feedback where decision was BUY/SMALL but outcome was RUG
   */
  private async computeMissRate(windowMs: number): Promise<number> {
    const since = Date.now() - windowMs;

    // Total labeled decisions in window
    const totalStmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM feedback_records 
       WHERE labeled = 1 AND labeledAt > ?`,
    );
    const total = (totalStmt.get(since) as any)?.cnt || 0;

    if (total === 0) return 0;

    // Misses: BUY/SMALL decisions that resulted in RUG
    const missStmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM feedback_records 
       WHERE labeled = 1 
         AND labeledAt > ? 
         AND (decision_str = 'BUY' OR decision_str = 'SMALL')
         AND outcome = 'RUG'`,
    );
    const misses = (missStmt.get(since) as any)?.cnt || 0;

    return misses / total;
  }

  /**
   * Compute signal decay: information gain drop week-over-week
   * Uses a simple heuristic: correlation between signal value and outcome
   */
  private async computeSignalDecay(): Promise<SignalPredictiveInfo[]> {
    // Signals to track:
    // - mintEnabled, isHoneypot, lpLocked, top10HolderPct, etc.

    const signals = [
      'mintEnabled',
      'isHoneypot',
      'lpLocked',
      'sellTax',
      'top10HolderPct',
      'devWalletPct',
      'isKnownRugDeployer',
    ];

    const result: SignalPredictiveInfo[] = [];

    for (const signal of signals) {
      const currentWeekIG = await this.computeInformationGain(signal, 7 * 24 * 60 * 60 * 1000);
      const priorWeekIG = await this.computeInformationGain(signal, 14 * 24 * 60 * 60 * 1000);

      const decay = priorWeekIG > 0 ? (priorWeekIG - currentWeekIG) / priorWeekIG : 0;
      const isDecaying = decay > this.config.informationGainDecayThreshold;

      result.push({
        signal,
        informationGain: currentWeekIG,
        isDecaying,
      });
    }

    return result;
  }

  /**
   * Compute information gain (entropy reduction) for a signal
   * Simplified: correlation between signal and outcome in labeled data
   */
  private async computeInformationGain(
    signal: string,
    windowMs: number,
  ): Promise<number> {
    // Query labeled feedback for this signal in the window
    // For now: simplified heuristic
    // In production: compute Shannon entropy and mutual information

    // Placeholder: return random value for development
    // Real implementation would compute correlation via SQL queries

    return Math.random() * 0.5 + 0.3; // 0.3-0.8 range
  }

  /**
   * Compute confidence in regime shift detection (0-1)
   */
  private computeConfidence(
    missRateIncrease: number,
    decayingSignals: SignalPredictiveInfo[],
  ): number {
    let confidence = 0;

    // Miss rate contribution
    if (missRateIncrease > this.config.missRateIncreaseThreshold) {
      confidence += Math.min(missRateIncrease, 0.6);
    }

    // Decaying signal contribution
    const decayingCount = decayingSignals.filter((s) => s.isDecaying).length;
    if (decayingCount >= 2) {
      confidence += Math.min(decayingCount * 0.15, 0.4);
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Suggest signal weight adjustments when regime shifts
   */
  getSuggestedSignalWeights(): Record<string, number> {
    // Default weights
    const weights: Record<string, number> = {
      ContractModel: 0.35,
      WalletModel: 0.30,
      LiquidityModel: 0.25,
      SocialModel: 0.10,
    };

    // If regime is shifting, increase anomaly sensitivity
    if (this.currentRegime.shiftDetected) {
      // Downweight decaying signals
      for (const decayingSignal of this.currentRegime.decayingSignals) {
        if (decayingSignal.isDecaying) {
          // Map signal name to model
          // This is a simplified mapping
          if (decayingSignal.signal.startsWith('mint') || decayingSignal.signal === 'isHoneypot') {
            weights['ContractModel'] *= 0.9;
          }
        }
      }
    }

    // Renormalize
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    Object.keys(weights).forEach((k) => {
      weights[k] /= sum;
    });

    return weights;
  }
}
