import type { BotConfig } from "./config.ts";
import type { TokenLaunchEvent, TokenRiskScorer } from "./token_risk_scorer.ts";
import { RiskManager } from "./risk_manager.ts";
import type { Logger } from "./utils/logger.ts";
import { JitoClient } from "./utils/jito_client.ts";
import { WalletRotator, type WalletRef } from "./wallet_rotator.ts";

export interface SwapBundleRequest {
  event: TokenLaunchEvent;
  wallet: WalletRef;
  amountSol: number;
  stopLossPct: number;
  takeProfitPct: number;
  tipAccount?: string;
}

export interface SwapBundle {
  transactionsBase64: string[];
  quoteId: string;
}

export type SwapBundleBuilder = (request: SwapBundleRequest) => Promise<SwapBundle>;

export interface TradeReceipt {
  mint: string;
  mode: string;
  walletId: string;
  amountSol: number;
  accepted: boolean;
  reason: string;
  pnlSol?: number;
  bundleId?: string;
}

export interface EngineStats {
  received: number;
  processed: number;
  accepted: number;
  rejected: number;
  executed: number;
  failed: number;
}

export class SniperEngine {
  config: BotConfig;
  scorer: TokenRiskScorer;
  risk: RiskManager;
  wallets: WalletRotator;
  jito: JitoClient;
  logger: Logger;
  buildSwapBundle?: SwapBundleBuilder;
  queue: TokenLaunchEvent[] = [];
  running = false;
  stats: EngineStats = {
    received: 0,
    processed: 0,
    accepted: 0,
    rejected: 0,
    executed: 0,
    failed: 0
  };

  constructor(config: BotConfig, scorer: TokenRiskScorer, logger: Logger, buildSwapBundle?: SwapBundleBuilder) {
    this.config = config;
    this.scorer = scorer;
    this.risk = new RiskManager(config.risk);
    this.wallets = new WalletRotator(config.wallets, logger);
    this.jito = new JitoClient(config.jito, logger);
    this.logger = logger.child({ component: "sniper_engine" });
    this.buildSwapBundle = buildSwapBundle;
  }

  async start(): Promise<void> {
    if (this.config.mode === "live" && !this.config.liveTrading) {
      throw new Error("live_mode_requires_LIVE_TRADING_true");
    }
    await this.wallets.start();
    this.running = true;
    this.pump();
    this.logger.info({ mode: this.config.mode, queueDepth: this.queue.length }, "engine_started");
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.wallets.stop();
    this.logger.info({ stats: this.stats, risk: this.risk.snapshot() }, "engine_stopped");
  }

  submit(event: TokenLaunchEvent): boolean {
    this.stats.received += 1;
    if (this.queue.length >= this.config.throughput.maxQueueDepth) {
      this.stats.rejected += 1;
      this.logger.warn({ mint: event.mint, queueDepth: this.queue.length }, "event_queue_full");
      return false;
    }
    this.queue.push(event);
    return true;
  }

  async drain(): Promise<void> {
    while (this.queue.length > 0) {
      await this.processBatch();
    }
  }

  async processBatch(): Promise<void> {
    const batch = this.queue.splice(0, this.config.throughput.eventLoopBatchSize);
    await Promise.all(batch.map((event) => this.processEvent(event)));
  }

  pump(): void {
    if (!this.running) {
      return;
    }
    void this.processBatch().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message }, "batch_processing_failed");
    }).finally(() => {
      if (this.running) {
        setImmediate(() => this.pump());
      }
    });
  }

  async processEvent(event: TokenLaunchEvent): Promise<TradeReceipt | undefined> {
    this.stats.processed += 1;
    try {
      const riskResult = await this.scorer.evaluate(event);
      if (!riskResult.accepted) {
        this.stats.rejected += 1;
        this.logger.debug({ mint: event.mint, reasons: riskResult.reasons, riskProbability: riskResult.riskProbability }, "token_rejected");
        return undefined;
      }

      const plan = this.risk.planPosition({
        mint: event.mint,
        timestamp: event.timestamp,
        regime: riskResult.regime,
        riskProbability: riskResult.riskProbability,
        mlConfidence: riskResult.mlConfidence,
        winProbability: event.predictedWinProb,
        rewardRiskRatio: event.rewardRiskRatio,
        liquiditySol: event.liquiditySol,
        volatility: event.volatility1m
      });

      if (!plan.accepted) {
        this.stats.rejected += 1;
        this.logger.debug({ mint: event.mint, reason: plan.reason }, "position_rejected");
        return undefined;
      }

      this.stats.accepted += 1;
      const wallet = this.wallets.nextWallet();
      await this.wallets.publishAllocation(wallet, event.mint, plan.amountSol);
      this.risk.recordEntry({
        mint: event.mint,
        amountSol: plan.amountSol,
        openedAt: Date.now(),
        riskMode: plan.riskMode
      });

      const receipt = await this.execute(event, wallet, plan.amountSol, plan.stopLossPct, plan.takeProfitPct);
      this.wallets.complete(wallet.id);
      return receipt;
    } catch (error) {
      this.stats.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ mint: event.mint, error: message }, "event_processing_failed");
      return undefined;
    }
  }

  async execute(event: TokenLaunchEvent, wallet: WalletRef, amountSol: number, stopLossPct: number, takeProfitPct: number): Promise<TradeReceipt> {
    if (this.config.mode === "paper") {
      const friction = 0.0005 + event.jitoCompetition * 0.00025;
      const pnlSol = amountSol * ((event.futureReturnPct || 0) - friction) - this.config.jito.minTipSol;
      this.risk.recordExit(event.mint, pnlSol);
      this.stats.executed += 1;
      return {
        mint: event.mint,
        mode: "paper",
        walletId: wallet.id,
        amountSol,
        accepted: true,
        reason: "paper_fill",
        pnlSol
      };
    }

    if (!this.buildSwapBundle) {
      throw new Error("live_swap_bundle_builder_required");
    }

    const tipAccount = await this.jito.nextTipAccount();
    const bundle = await this.buildSwapBundle({
      event,
      wallet,
      amountSol,
      stopLossPct,
      takeProfitPct,
      tipAccount
    });
    const result = await this.jito.sendBundle(bundle.transactionsBase64, event.jitoCompetition);
    this.stats.executed += 1;
    return {
      mint: event.mint,
      mode: "live",
      walletId: wallet.id,
      amountSol,
      accepted: result.accepted,
      reason: "jito_bundle",
      bundleId: result.bundleId
    };
  }
}
