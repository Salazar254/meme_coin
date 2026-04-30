/**
 * engine/hard-filter.ts
 *
 * Ultra-fast pre-trade filter that rejects tokens immediately on critical flags.
 * - Returns score + decision in <400ms
 * - Uses parallel API checks
 * - Fails safely (reject on timeout/error)
 * - ML can NEVER override critical reject flags
 */

import {
  TokenSignal,
  HardFilterResult,
  HardRejectReason,
} from './types';

// ─── Configuration ──────────────────────────────────────────────────

export interface HardFilterConfig {
  /** Max time allowed for all parallel checks (ms) */
  readonly maxLatencyMs: number;
  /** Sell tax threshold (basis points) — above this = reject */
  readonly maxSellTaxBps: number;
  /** Top-10 holder concentration threshold (%) — above this = reject */
  readonly maxTop10HolderPct: number;
  /** Dev wallet concentration threshold (%) */
  readonly maxDevWalletPct: number;
  /** Wallet cluster score threshold — above this = suspicious */
  readonly maxWalletClusterScore: number;
  /** Known rug deployer blacklist */
  readonly deployerBlacklist: ReadonlySet<string>;
  /** Weight for each check in the composite score */
  readonly weights: Readonly<HardFilterWeights>;
}

export interface HardFilterWeights {
  mintEnabled: number;
  honeypot: number;
  rugDeployer: number;
  lpLock: number;
  sellTax: number;
  holderConcentration: number;
  devWallet: number;
  walletCluster: number;
  ownershipNotRenounced: number;
}

const DEFAULT_WEIGHTS: HardFilterWeights = {
  mintEnabled: 30,
  honeypot: 30,
  rugDeployer: 25,
  lpLock: 15,
  sellTax: 12,
  holderConcentration: 10,
  devWallet: 8,
  walletCluster: 6,
  ownershipNotRenounced: 5,
};

const DEFAULT_CONFIG: HardFilterConfig = {
  maxLatencyMs: 400,
  maxSellTaxBps: 15,
  maxTop10HolderPct: 85,
  maxDevWalletPct: 30,
  maxWalletClusterScore: 0.8,
  deployerBlacklist: new Set<string>(),
  weights: DEFAULT_WEIGHTS,
};

// ─── Critical Flags ──────────────────────────────────────────────────
// These flags result in immediate, non-overridable rejection.

const CRITICAL_REJECT_FLAGS: ReadonlySet<HardRejectReason> = new Set([
  HardRejectReason.MINT_ENABLED,
  HardRejectReason.HONEYPOT_DETECTED,
  HardRejectReason.KNOWN_RUG_DEPLOYER,
]);

// ─── Hard Filter Engine ──────────────────────────────────────────────

export class HardFilter {
  private readonly config: HardFilterConfig;
  private mutableWeights: HardFilterWeights;

  // Stats
  private totalEvaluated = 0;
  private totalRejected = 0;
  private totalPassed = 0;
  private rejectReasonCounts: Map<HardRejectReason, number> = new Map();

  constructor(config?: Partial<HardFilterConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      weights: {
        ...DEFAULT_WEIGHTS,
        ...(config?.weights ?? {}),
      },
    };
    this.mutableWeights = { ...this.config.weights };
  }

  /**
   * Evaluate a token signal against all hard rejection criteria.
   * Returns within maxLatencyMs. Fails safely (rejects on error).
   *
   * ML can NEVER override a critical reject.
   */
  async evaluate(signal: TokenSignal): Promise<HardFilterResult> {
    const startMs = Date.now();
    const reasons: HardRejectReason[] = [];
    let score = 0;

    try {
      // Run all checks in parallel for speed
      const checks = await Promise.race([
        this.runAllChecks(signal),
        this.timeoutReject(this.config.maxLatencyMs),
      ]);

      if (checks === null) {
        // Timeout — fail safe: reject
        return this.buildResult(false, 100, [HardRejectReason.FETCH_TIMEOUT], startMs, true);
      }

      // Aggregate results
      for (const check of checks) {
        if (check.triggered) {
          reasons.push(check.reason);
          score += check.weight;
        }
      }
    } catch {
      // Error — fail safe: reject
      return this.buildResult(false, 100, [HardRejectReason.FETCH_TIMEOUT], startMs, true);
    }

    const hasCritical = reasons.some((r) => CRITICAL_REJECT_FLAGS.has(r));
    const passed = !hasCritical && reasons.length === 0;

    this.totalEvaluated++;
    if (passed) this.totalPassed++;
    else this.totalRejected++;
    for (const r of reasons) {
      this.rejectReasonCounts.set(r, (this.rejectReasonCounts.get(r) ?? 0) + 1);
    }

    return this.buildResult(passed, Math.min(score, 100), reasons, startMs, hasCritical);
  }

  /**
   * Update filter weights from feedback loop.
   * Does NOT affect critical reject flags — those remain absolute.
   */
  updateWeights(newWeights: Partial<HardFilterWeights>): void {
    this.mutableWeights = { ...this.mutableWeights, ...newWeights };
  }

  getStats(): Record<string, unknown> {
    const reasonBreakdown: Record<string, number> = {};
    for (const [reason, count] of this.rejectReasonCounts) {
      reasonBreakdown[reason] = count;
    }
    return {
      totalEvaluated: this.totalEvaluated,
      totalRejected: this.totalRejected,
      totalPassed: this.totalPassed,
      passRate: this.totalEvaluated > 0 ? this.totalPassed / this.totalEvaluated : 0,
      reasonBreakdown,
    };
  }

  // ── Private ────────────────────────────────────────────────────────

  private async runAllChecks(
    signal: TokenSignal,
  ): Promise<Array<{ reason: HardRejectReason; triggered: boolean; weight: number }>> {
    // All checks run in parallel — each is a pure function on signal data
    return Promise.all([
      this.checkMintEnabled(signal),
      this.checkHoneypot(signal),
      this.checkRugDeployer(signal),
      this.checkLpLock(signal),
      this.checkSellTax(signal),
      this.checkHolderConcentration(signal),
    ]);
  }

  private async checkMintEnabled(signal: TokenSignal) {
    return {
      reason: HardRejectReason.MINT_ENABLED,
      triggered: signal.mintEnabled === true,
      weight: this.mutableWeights.mintEnabled,
    };
  }

  private async checkHoneypot(signal: TokenSignal) {
    return {
      reason: HardRejectReason.HONEYPOT_DETECTED,
      triggered: signal.isHoneypot === true,
      weight: this.mutableWeights.honeypot,
    };
  }

  private async checkRugDeployer(signal: TokenSignal) {
    const isBlacklisted =
      signal.isKnownRugDeployer === true ||
      this.config.deployerBlacklist.has(signal.mint);
    return {
      reason: HardRejectReason.KNOWN_RUG_DEPLOYER,
      triggered: isBlacklisted,
      weight: this.mutableWeights.rugDeployer,
    };
  }

  private async checkLpLock(signal: TokenSignal) {
    const hasLpProtection = signal.lpLocked === true || signal.lpBurned === true;
    return {
      reason: HardRejectReason.NO_LP_LOCK,
      triggered: !hasLpProtection,
      weight: this.mutableWeights.lpLock,
    };
  }

  private async checkSellTax(signal: TokenSignal) {
    return {
      reason: HardRejectReason.EXTREME_SELL_TAX,
      triggered: signal.sellTax > this.config.maxSellTaxBps,
      weight: this.mutableWeights.sellTax,
    };
  }

  private async checkHolderConcentration(signal: TokenSignal) {
    const isConcentrated =
      signal.top10HolderPct > this.config.maxTop10HolderPct ||
      signal.devWalletPct > this.config.maxDevWalletPct ||
      signal.walletClusterScore > this.config.maxWalletClusterScore;
    return {
      reason: HardRejectReason.HOLDER_CONCENTRATION,
      triggered: isConcentrated,
      weight: this.mutableWeights.holderConcentration + this.mutableWeights.devWallet + this.mutableWeights.walletCluster,
    };
  }

  private async timeoutReject(ms: number): Promise<null> {
    return new Promise((resolve) => setTimeout(() => resolve(null), ms));
  }

  private buildResult(
    passed: boolean,
    score: number,
    reasons: HardRejectReason[],
    startMs: number,
    isCriticalReject: boolean,
  ): HardFilterResult {
    return {
      passed,
      score,
      reasons,
      latencyMs: Date.now() - startMs,
      isCriticalReject,
    };
  }
}
