import type { BotConfig } from "../src/config.ts";
import { RiskManager } from "../src/risk_manager.ts";
import type { TokenRiskScorer } from "../src/token_risk_scorer.ts";
import type { Logger } from "../src/utils/logger.ts";
import { assertNoFutureLeakage, type HistoricalDataset, type HistoricalLaunchEvent, type JitoTipBar, type OhlcvBar } from "./data_loader.ts";
import { computeMetrics, type BacktestMetrics, type TradeRecord } from "./metrics.ts";
import { poolFromPriceAndLiquidity, simulateAmmSwap } from "./impact_model.ts";

export interface BacktestResult {
  trades: TradeRecord[];
  metrics: BacktestMetrics;
  rejected: Record<string, number>;
}

interface OpenPosition {
  mint: string;
  openedAt: number;
  amountSol: number;
  tokenAmount: number;
  entryPriceSol: number;
  stopLossPct: number;
  takeProfitPct: number;
  timeToRugHours: number;
  cluster: string;
  entryTipSol: number;
  retryFeeSol: number;
}

const ATA_RENT_SOL = 0.002039;
const FAILED_TX_FEE_SOL = 0.000005;
const RECLAIM_ATA_RENT_ON_EXIT = true;

export class HonestBacktestEngine {
  config: BotConfig;
  scorer: TokenRiskScorer;
  risk: RiskManager;
  logger: Logger;
  rejected: Record<string, number> = {};
  openPositions = new Map<string, OpenPosition>();
  trades: TradeRecord[] = [];
  latestBars = new Map<string, OhlcvBar>();
  rngState = 20260505;

  constructor(config: BotConfig, scorer: TokenRiskScorer, logger: Logger) {
    this.config = config;
    this.scorer = scorer;
    this.risk = new RiskManager(config.risk);
    this.logger = logger.child({ component: "honest_backtest" });
  }

  async run(dataset: HistoricalDataset): Promise<BacktestResult> {
    const events = [...dataset.events].sort((a, b) => a.timestamp - b.timestamp);
    const bars = [...dataset.ohlcv].sort((a, b) => a.timestamp - b.timestamp);
    let barIndex = 0;

    for (const event of events) {
      while (barIndex < bars.length && bars[barIndex].timestamp <= event.timestamp) {
        this.onBar(bars[barIndex], dataset.jitoTips);
        barIndex += 1;
      }
      await this.onEvent(event, dataset.jitoTips);
    }

    while (barIndex < bars.length) {
      this.onBar(bars[barIndex], dataset.jitoTips);
      barIndex += 1;
    }

    for (const position of [...this.openPositions.values()]) {
      const bar = this.latestBars.get(position.mint);
      if (bar) {
        this.closePosition(position, bar, "end_of_feed", dataset.jitoTips);
      }
    }

    const metrics = computeMetrics(this.trades, this.config.risk.startingCapitalSol);
    this.logger.info({ metrics, rejected: this.rejected }, "backtest_completed");
    return { trades: this.trades, metrics, rejected: this.rejected };
  }

  async onEvent(event: HistoricalLaunchEvent, tips: JitoTipBar[]): Promise<void> {
    assertNoFutureLeakage(event as unknown as Record<string, unknown>, event.mint);
    const score = await this.scorer.evaluate(event);
    if (!score.accepted) {
      this.reject(score.reasons[0] || "scorer_rejected");
      return;
    }

    const plan = this.risk.planPosition({
      mint: event.mint,
      timestamp: event.timestamp,
      regime: score.regime,
      riskProbability: score.riskProbability,
      mlConfidence: score.mlConfidence,
      winProbability: event.predictedWinProb,
      rewardRiskRatio: event.rewardRiskRatio,
      liquiditySol: event.liquiditySol,
      volatility: event.volatility1m,
      deployer: event.deployer,
      launchPlatform: event.launchPlatform,
      rugUncertaintyStd: score.uncertainty,
      memeVolatilityIndex: event.volatility1m
    });
    if (!plan.accepted) {
      this.reject(plan.reason);
      return;
    }

    const price = event.entryPriceSol || this.latestBars.get(event.mint)?.close || Math.max(event.marketCapSol / 1_000_000, 1e-9);
    const pool = event.baseReserveSol && event.quoteReserveTokens
      ? { inputReserve: event.baseReserveSol, outputReserve: event.quoteReserveTokens, feeBps: 30 }
      : poolFromPriceAndLiquidity(price, Math.max(event.liquiditySol, plan.amountSol * 2));
    const impact = simulateAmmSwap({
      inputAmount: plan.amountSol,
      inputReserve: pool.inputReserve,
      outputReserve: pool.outputReserve,
      feeBps: pool.feeBps,
      maxSlippagePct: 3,
      allowPartialFill: true
    });
    if (!impact.accepted && !impact.partialFill) {
      this.reject(impact.reason);
      return;
    }

    const amountSol = impact.inputAmount;
    let tipSol = this.tipFor(event.timestamp, event.jitoCompetition, tips);
    let retryFeeSol = 0;
    if (!this.bundleLands(tipSol, event.jitoCompetition, tips, event.timestamp)) {
      retryFeeSol += FAILED_TX_FEE_SOL;
      const retryTip = Math.min(this.config.jito.maxTipSol, tipSol * 1.5);
      if (!this.bundleLands(retryTip, Math.max(0, event.jitoCompetition - 0.08), tips, event.timestamp + 800)) {
        this.trades.push({
          mint: event.mint,
          openedAt: event.timestamp,
          closedAt: event.timestamp + 800,
          amountSol: 0,
          pnlSol: -retryFeeSol,
          returnPct: 0,
          exitReason: "failed_entry_bundle",
          cluster: String(event.launchPlatform || "unknown")
        });
        this.risk.realizedPnlSol -= retryFeeSol;
        this.reject("jito_bundle_not_landed");
        return;
      }
      tipSol = retryTip;
      retryFeeSol += FAILED_TX_FEE_SOL;
    }
    if (amountSol > event.liquiditySol * 0.02 && impact.chunks.length < 2) {
      this.reject("order_too_large_for_pool_depth");
      return;
    }

    this.risk.recordEntry({
      mint: event.mint,
      amountSol,
      openedAt: event.timestamp,
      riskMode: plan.riskMode,
      cluster: String(event.launchPlatform || "unknown"),
      platform: String(event.launchPlatform || "unknown"),
      deployer: event.deployer
    });
    this.openPositions.set(event.mint, {
      mint: event.mint,
      openedAt: event.timestamp,
      amountSol,
      tokenAmount: impact.outputAmount,
      entryPriceSol: price,
      stopLossPct: plan.stopLossPct,
      takeProfitPct: plan.takeProfitPct,
      timeToRugHours: score.timeToRugHours ?? 24,
      cluster: String(event.launchPlatform || "unknown"),
      entryTipSol: tipSol,
      retryFeeSol
    });
  }

  onBar(bar: OhlcvBar, tips: JitoTipBar[]): void {
    this.latestBars.set(bar.mint, bar);
    const position = this.openPositions.get(bar.mint);
    if (!position) {
      return;
    }
    const stopPrice = position.entryPriceSol * (1 - position.stopLossPct);
    const takeProfitPrice = position.entryPriceSol * (1 + position.takeProfitPct);
    const ageHours = (bar.timestamp - position.openedAt) / 3_600_000;
    if (bar.low <= stopPrice) {
      this.closePosition(position, { ...bar, close: stopPrice }, "stop_loss", tips);
    } else if (bar.high >= takeProfitPrice) {
      this.closePosition(position, { ...bar, close: takeProfitPrice }, "take_profit", tips);
    } else if (position.timeToRugHours - ageHours < 2) {
      this.closePosition(position, bar, "time_to_rug_prediction", tips);
    } else if (ageHours >= 24) {
      this.closePosition(position, bar, "max_hold_time", tips);
    }
  }

  closePosition(position: OpenPosition, bar: OhlcvBar, reason: string, tips: JitoTipBar[]): void {
    if (!this.openPositions.has(position.mint)) {
      return;
    }
    const reversePool = bar.baseReserveSol && bar.quoteReserveTokens
      ? { inputReserve: bar.quoteReserveTokens, outputReserve: bar.baseReserveSol, feeBps: 30 }
      : { inputReserve: Math.max(position.tokenAmount * 10, 1e-9), outputReserve: Math.max(position.tokenAmount * bar.close * 10, 1e-9), feeBps: 30 };
    const impact = simulateAmmSwap({
      inputAmount: position.tokenAmount,
      inputReserve: reversePool.inputReserve,
      outputReserve: reversePool.outputReserve,
      feeBps: reversePool.feeBps,
      maxSlippagePct: 3,
      allowPartialFill: false
    });
    const grossExitSol = impact.outputAmount > 0 ? impact.outputAmount : position.tokenAmount * bar.close * 0.997;
    const exitTipSol = this.tipFor(bar.timestamp, 0.5, tips);
    const rentReclaimSol = RECLAIM_ATA_RENT_ON_EXIT ? ATA_RENT_SOL : 0;
    const pnlSol = grossExitSol - position.amountSol - position.entryTipSol - exitTipSol - ATA_RENT_SOL + rentReclaimSol - position.retryFeeSol;
    this.openPositions.delete(position.mint);
    this.risk.recordExit(position.mint, pnlSol);
    this.trades.push({
      mint: position.mint,
      openedAt: position.openedAt,
      closedAt: bar.timestamp,
      amountSol: position.amountSol,
      pnlSol,
      returnPct: pnlSol / Math.max(position.amountSol, 1e-9),
      exitReason: reason,
      cluster: position.cluster
    });
  }

  tipFor(timestamp: number, competition: number, tips: JitoTipBar[]): number {
    const bar = latestTip(timestamp, tips);
    if (!bar) {
      return this.config.jito.minTipSol + (this.config.jito.maxTipSol - this.config.jito.minTipSol) * Math.min(1, competition) ** 2;
    }
    if (competition > 0.85) {
      return Math.min(this.config.jito.maxTipSol, bar.p95TipSol);
    }
    if (competition > 0.55) {
      return Math.min(this.config.jito.maxTipSol, bar.p75TipSol);
    }
    return Math.max(this.config.jito.minTipSol, bar.p50TipSol);
  }

  bundleLands(tipSol: number, competition: number, tips: JitoTipBar[], timestamp: number): boolean {
    const bar = latestTip(timestamp, tips);
    const rank = !bar ? tipSol / Math.max(this.config.jito.maxTipSol, 1e-9) : tipSol >= bar.p95TipSol ? 0.95 : tipSol >= bar.p75TipSol ? 0.75 : tipSol >= bar.p50TipSol ? 0.5 : 0.25;
    const probability = Math.max(0.05, Math.min(0.99, rank - competition * 0.22 + 0.22));
    return this.nextRandom() <= probability;
  }

  reject(reason: string): void {
    this.rejected[reason] = (this.rejected[reason] || 0) + 1;
  }

  nextRandom(): number {
    this.rngState += 0x6d2b79f5;
    let value = this.rngState;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }
}

const latestTip = (timestamp: number, tips: JitoTipBar[]): JitoTipBar | undefined => {
  let latest: JitoTipBar | undefined;
  for (const tip of tips) {
    if (tip.timestamp <= timestamp) {
      latest = tip;
    } else {
      break;
    }
  }
  return latest;
};
