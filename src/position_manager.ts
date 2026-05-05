import { Redis } from "ioredis";
import type { RiskManager } from "./risk_manager.ts";
import { evaluateExit, type ExitDecision } from "./exit_engine.ts";
import type { Logger } from "./utils/logger.ts";

export interface ManagedPosition {
  mint: string;
  walletId: string;
  amountSol: number;
  tokenAmount: number;
  entryPriceSol: number;
  openedAt: number;
  dynamicStop: number;
  dynamicTakeProfit: number;
  maxHoldMs: number;
  timeToRugHours?: number;
  cluster?: string;
}

export interface PriceQuote {
  mint: string;
  priceSol: number;
  timestamp: number;
}

export interface PriceFeed {
  quote(mint: string): Promise<PriceQuote | undefined>;
}

export interface ExitExecutionRequest {
  position: ManagedPosition;
  decision: ExitDecision;
  quote: PriceQuote;
}

export interface ExitExecutionReceipt {
  accepted: boolean;
  reason: string;
  realizedSol: number;
  bundleId?: string;
}

export interface ExitExecutionBackend {
  executeExit(request: ExitExecutionRequest): Promise<ExitExecutionReceipt>;
}

export interface PositionManagerOptions {
  redisUrl?: string;
  pollIntervalMs?: number;
  maxHoldMs?: number;
}

export class PositionManager {
  positions = new Map<string, ManagedPosition>();
  risk: RiskManager;
  priceFeed: PriceFeed;
  executor: ExitExecutionBackend;
  logger: Logger;
  redis?: Redis;
  pollIntervalMs: number;
  maxHoldMs: number;
  timer?: NodeJS.Timeout;

  constructor(
    risk: RiskManager,
    priceFeed: PriceFeed,
    executor: ExitExecutionBackend,
    logger: Logger,
    options: PositionManagerOptions = {}
  ) {
    this.risk = risk;
    this.priceFeed = priceFeed;
    this.executor = executor;
    this.logger = logger.child({ component: "position_manager" });
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.maxHoldMs = options.maxHoldMs ?? 24 * 3_600_000;
    if (options.redisUrl) {
      this.redis = new Redis(options.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    }
  }

  async start(): Promise<void> {
    if (this.redis) {
      await this.redis.connect();
      await this.loadState();
    }
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ error: message }, "position_poll_failed");
      });
    }, this.pollIntervalMs);
    this.logger.info({ openPositions: this.positions.size, pollIntervalMs: this.pollIntervalMs }, "position_manager_started");
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.redis) {
      await this.persistState();
      await this.redis.quit();
    }
    this.logger.info({ openPositions: this.positions.size }, "position_manager_stopped");
  }

  async track(position: ManagedPosition): Promise<void> {
    const normalized = { ...position, maxHoldMs: position.maxHoldMs || this.maxHoldMs };
    this.positions.set(position.mint, normalized);
    await this.persistPosition(normalized);
    this.logger.info({ mint: position.mint, walletId: position.walletId, amountSol: position.amountSol }, "position_tracked");
  }

  async pollOnce(now = Date.now()): Promise<void> {
    for (const position of [...this.positions.values()]) {
      const quote = await this.priceFeed.quote(position.mint);
      if (!quote) {
        this.logger.warn({ mint: position.mint }, "price_quote_missing");
        continue;
      }
      const decision = evaluateExit({
        entryPriceSol: position.entryPriceSol,
        currentPriceSol: quote.priceSol,
        dynamicStop: position.dynamicStop,
        dynamicTakeProfit: position.dynamicTakeProfit,
        openedAt: position.openedAt,
        now,
        maxHoldMs: position.maxHoldMs,
        timeToRugHours: position.timeToRugHours
      });
      if (decision.shouldExit) {
        await this.exit(position, decision, quote);
      }
    }
  }

  async exit(position: ManagedPosition, decision: ExitDecision, quote: PriceQuote): Promise<void> {
    const receipt = await this.executor.executeExit({ position, decision, quote });
    if (!receipt.accepted) {
      this.logger.warn({ mint: position.mint, reason: receipt.reason, exitReason: decision.reason }, "exit_rejected");
      return;
    }
    const pnlSol = receipt.realizedSol - position.amountSol;
    this.risk.recordExit(position.mint, pnlSol);
    this.positions.delete(position.mint);
    await this.deletePosition(position.mint);
    this.logger.info({
      mint: position.mint,
      walletId: position.walletId,
      exitReason: decision.reason,
      realizedSol: receipt.realizedSol,
      pnlSol,
      bundleId: receipt.bundleId
    }, "position_exited");
  }

  async loadState(): Promise<void> {
    if (!this.redis) {
      return;
    }
    const raw = await this.redis.hgetall("positions:open");
    for (const [mint, value] of Object.entries(raw)) {
      this.positions.set(mint, JSON.parse(String(value)) as ManagedPosition);
    }
  }

  async persistState(): Promise<void> {
    await Promise.all([...this.positions.values()].map((position) => this.persistPosition(position)));
  }

  async persistPosition(position: ManagedPosition): Promise<void> {
    if (this.redis) {
      await this.redis.hset("positions:open", position.mint, JSON.stringify(position));
    }
  }

  async deletePosition(mint: string): Promise<void> {
    if (this.redis) {
      await this.redis.hdel("positions:open", mint);
    }
  }
}
