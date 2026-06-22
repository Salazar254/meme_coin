/**
 * engine/execution-router.ts
 *
 * Execution router that:
 *   - Prioritizes orders by expected edge and urgency
 *   - Enforces deadline-based cancellation
 *   - Tracks fill rates and latency per bucket
 *   - Supports concurrent execution with bounded parallelism
 *   - Reports fill quality back to feedback loop
 */

import {
  ExecutionOrder,
  ExecutionResult,
  SizingBucket,
  MarketRegime,
} from './types';

// ─── Configuration ──────────────────────────────────────────────────

export interface ExecutionRouterConfig {
  /** Maximum concurrent executions */
  readonly maxConcurrentExecutions: number;
  /** Default deadline for order execution (ms) */
  readonly defaultDeadlineMs: number;
  /** Base slippage simulation (for testing / dry-run) */
  readonly baseSlippagePct: number;
  /** Base latency simulation (ms) */
  readonly baseLatencyMs: number;
  /** Percentage of orders that fail to fill (simulation) */
  readonly simulatedFailRate: number;
  /** Whether to use real execution (false = simulation) */
  readonly liveExecution: boolean;
  /** Priority queue: max size before dropping low-priority orders */
  readonly maxQueueSize: number;
}

const DEFAULT_CONFIG: ExecutionRouterConfig = {
  maxConcurrentExecutions: 10,
  defaultDeadlineMs: 3000,
  baseSlippagePct: 0.02,
  baseLatencyMs: 150,
  simulatedFailRate: 0.08,
  liveExecution: false,
  maxQueueSize: 200,
};

// ─── Execution Stats ─────────────────────────────────────────────────

interface BucketStats {
  attempted: number;
  filled: number;
  failed: number;
  totalLatencyMs: number;
  totalSlippage: number;
}

// ─── Execution Router ────────────────────────────────────────────────

export class ExecutionRouter {
  private readonly config: ExecutionRouterConfig;

  // Priority queue (sorted by priority, lower = higher priority)
  private queue: ExecutionOrder[] = [];
  private activeExecutions = 0;

  // Stats per bucket
  private bucketStats: Map<SizingBucket, BucketStats> = new Map();

  // Global stats
  private totalAttempted = 0;
  private totalFilled = 0;
  private totalFailed = 0;
  private latencies: number[] = [];
  private readonly maxLatencyHistory = 1000;

  constructor(config?: Partial<ExecutionRouterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize bucket stats
    for (const bucket of Object.values(SizingBucket)) {
      this.bucketStats.set(bucket, {
        attempted: 0,
        filled: 0,
        failed: 0,
        totalLatencyMs: 0,
        totalSlippage: 0,
      });
    }
  }

  /**
   * Submit an order for execution.
   * Returns the execution result once filled or failed.
   */
  async execute(order: ExecutionOrder): Promise<ExecutionResult> {
    // Check deadline
    if (Date.now() > order.deadlineMs) {
      return this.buildFailedResult(order, 'deadline_expired');
    }

    // Queue management
    if (this.queue.length >= this.config.maxQueueSize) {
      // Drop lowest priority (highest priority number)
      this.queue.sort((a, b) => a.priority - b.priority);
      if (order.priority < this.queue[this.queue.length - 1].priority) {
        this.queue.pop(); // Remove lowest priority
        this.queue.push(order);
      } else {
        return this.buildFailedResult(order, 'queue_full');
      }
    } else {
      this.queue.push(order);
    }

    // Wait for execution slot
    while (this.activeExecutions >= this.config.maxConcurrentExecutions) {
      await sleep(5);  // Small yield
      if (Date.now() > order.deadlineMs) {
        this.removeFromQueue(order);
        return this.buildFailedResult(order, 'deadline_while_queued');
      }
    }

    this.removeFromQueue(order);
    this.activeExecutions++;

    try {
      const result = this.config.liveExecution
        ? await this.executeLive(order)
        : await this.executeSimulated(order);

      this.recordResult(result);
      return result;
    } finally {
      this.activeExecutions--;
    }
  }

  /**
   * Execute a batch of orders, prioritized by the priority field.
   */
  async executeBatch(orders: ExecutionOrder[]): Promise<ExecutionResult[]> {
    // Sort by priority (lower = higher priority)
    const sorted = [...orders].sort((a, b) => a.priority - b.priority);

    // Execute in parallel with bounded concurrency
    const results: ExecutionResult[] = [];
    const chunks = chunkArray(sorted, this.config.maxConcurrentExecutions);

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(chunk.map((o) => this.execute(o)));
      results.push(...chunkResults);
    }

    return results;
  }

  /**
   * Get execution statistics.
   */
  getStats(): Record<string, unknown> {
    const bucketBreakdown: Record<string, Record<string, number>> = {};
    for (const [bucket, stats] of this.bucketStats) {
      bucketBreakdown[bucket] = {
        attempted: stats.attempted,
        filled: stats.filled,
        failed: stats.failed,
        fillRate: stats.attempted > 0 ? stats.filled / stats.attempted : 0,
        avgLatencyMs: stats.attempted > 0 ? stats.totalLatencyMs / stats.attempted : 0,
        avgSlippage: stats.filled > 0 ? stats.totalSlippage / stats.filled : 0,
      };
    }

    return {
      totalAttempted: this.totalAttempted,
      totalFilled: this.totalFilled,
      totalFailed: this.totalFailed,
      fillRate: this.totalAttempted > 0 ? this.totalFilled / this.totalAttempted : 0,
      avgLatencyMs: this.computeAvgLatency(),
      p95LatencyMs: this.computeP95Latency(),
      activeExecutions: this.activeExecutions,
      queueDepth: this.queue.length,
      bucketBreakdown,
    };
  }

  // ── Private: Execution Modes ───────────────────────────────────────

  /**
   * Simulated execution for backtesting and dry-run mode.
   */
  private async executeSimulated(order: ExecutionOrder): Promise<ExecutionResult> {
    const startMs = Date.now();

    const regimeLatencyMultiplier = this.getRegimeLatencyMultiplier(order.regime);
    const queuePressure = this.queue.length / Math.max(this.config.maxQueueSize, 1);
    const latencyJitter = (Math.random() - 0.5) * this.config.baseLatencyMs * 0.45;
    let latency =
      this.config.baseLatencyMs * regimeLatencyMultiplier +
      latencyJitter +
      this.activeExecutions * 8 +
      queuePressure * 45;

    if (Math.random() < this.getLagSpikeProbability(order.regime)) {
      latency += this.config.baseLatencyMs * (1.0 + Math.random() * 1.4);
    }

    latency = Math.max(15, latency);
    await sleep(Math.min(latency, 30)); // Keep sim responsive while reporting realistic latency

    // Simulate fill failure
    if (Math.random() < this.config.simulatedFailRate) {
      return this.buildFailedResult(order, 'simulated_fill_failure', latency);
    }

    // Simulate slippage (worse for larger orders and lower liquidity)
    const sizeMultiplier = 1 + Math.max(0, order.sizeSol - 0.1) * 1.8;
    const regimeSlippageMultiplier = this.getRegimeSlippageMultiplier(order.regime);
    const slippage =
      this.config.baseSlippagePct *
      sizeMultiplier *
      regimeSlippageMultiplier *
      (0.75 + Math.random() * 0.8);

    if (slippage > order.maxSlippagePct) {
      return this.buildFailedResult(order, 'slippage_exceeded', latency);
    }

    const actualLatency = Math.max(Date.now() - startMs, latency);
    const jitoBoost = order.jitoTipSol ? Math.min(30, order.jitoTipSol * 1000) : 0;

    return {
      order,
      filled: true,
      fillSizeSol: order.sizeSol,
      slippagePct: Math.max(0, slippage - (order.jitoTipSol ? 0.005 : 0)),
      latencyMs: Math.max(5, (actualLatency > 0 ? actualLatency : latency) - jitoBoost),
      txHash: `sim_${order.mint.substring(0, 8)}_${Date.now()}`,
    };
  }
  /**
   * Live execution stub — to be connected to actual Solana transaction sender.
   */
  private async executeLive(order: ExecutionOrder): Promise<ExecutionResult> {
    const startMs = Date.now();

    // In production, this would:
    // 1. Build a Solana transaction (Jupiter swap or Raydium direct)
    // 2. Sign with wallet
    // 3. Send with priority fee
    // 4. Confirm with commitment level
    // 5. Return fill details

    // For now, delegate to simulated
    const result = await this.executeSimulated(order);
    return {
      ...result,
      latencyMs: Date.now() - startMs,
    };
  }

  // ── Private: Helpers ───────────────────────────────────────────────

  private recordResult(result: ExecutionResult): void {
    const bucket = result.order.bucket;
    const stats = this.bucketStats.get(bucket)!;

    this.totalAttempted++;
    stats.attempted++;

    if (result.filled) {
      this.totalFilled++;
      stats.filled++;
      stats.totalSlippage += result.slippagePct;
    } else {
      this.totalFailed++;
      stats.failed++;
    }

    stats.totalLatencyMs += result.latencyMs;
    this.latencies.push(result.latencyMs);
    while (this.latencies.length > this.maxLatencyHistory) {
      this.latencies.shift();
    }
  }

  private removeFromQueue(order: ExecutionOrder): void {
    const idx = this.queue.indexOf(order);
    if (idx >= 0) this.queue.splice(idx, 1);
  }

  private buildFailedResult(
    order: ExecutionOrder,
    error: string,
    latencyMs?: number,
  ): ExecutionResult {
    return {
      order,
      filled: false,
      fillSizeSol: 0,
      slippagePct: 0,
      latencyMs: latencyMs ?? 0,
      error,
    };
  }

  private getRegimeLatencyMultiplier(regime: MarketRegime): number {
    switch (regime) {
      case MarketRegime.ACCELERATING:
        return 0.9;
      case MarketRegime.NORMAL:
        return 1.0;
      case MarketRegime.FRAGILE:
        return 1.35;
      case MarketRegime.STRESS:
        return 1.65;
      default:
        return 1.0;
    }
  }

  private getRegimeSlippageMultiplier(regime: MarketRegime): number {
    switch (regime) {
      case MarketRegime.ACCELERATING:
        return 1.0;
      case MarketRegime.NORMAL:
        return 1.1;
      case MarketRegime.FRAGILE:
        return 1.4;
      case MarketRegime.STRESS:
        return 1.8;
      default:
        return 1.0;
    }
  }

  private getLagSpikeProbability(regime: MarketRegime): number {
    switch (regime) {
      case MarketRegime.ACCELERATING:
        return 0.03;
      case MarketRegime.NORMAL:
        return 0.06;
      case MarketRegime.FRAGILE:
        return 0.12;
      case MarketRegime.STRESS:
        return 0.24;
      default:
        return 0.05;
    }
  }

  private computeAvgLatency(): number {
    if (this.latencies.length === 0) return 0;
    return this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length;
  }

  private computeP95Latency(): number {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)];
  }
}

// ─── Utilities ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(arr: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
}
