/**
 * engine/types.ts
 *
 * Core type definitions for the high-throughput memecoin trading engine.
 * Covers the full pipeline: TokenSignals → HardFilter → OpportunityRanker →
 *   RegimeDetector → DynamicSizer → ExecutionRouter → FeedbackLoop
 *
 * Design: strict, no `any`, no optional core signals.
 */

// ─── Pipeline Flow ──────────────────────────────────────────────────

export type PipelineStage =
  | 'TOKEN_SIGNAL'
  | 'HARD_FILTER'
  | 'ML_RANK'
  | 'REGIME_DETECT'
  | 'DYNAMIC_SIZE'
  | 'EXECUTION'
  | 'FEEDBACK';

// ─── Token Signal ────────────────────────────────────────────────────

export interface TokenSignal {
  /** Mint address / token address */
  readonly mint: string;
  /** Unix timestamp (ms) when signal was received */
  readonly receivedAt: number;

  // ── On-chain basics ──
  liquiditySol: number;
  liquidityUsd: number;
  uniqueBuyers: number;
  totalVolume: number;
  marketCapSol: number;
  timeSinceLaunchSec: number;

  // ── Microstructure proxies ──
  slippageEstimate: number;
  priceGrowth1s: number;
  socialProxy1s: number;
  lpGrowth1s: number;
  buyersPerSol: number;
  volumeToLpRatio: number;

  // ── Log-scale features ──
  logLiquidity: number;
  logVolume: number;
  logMcap: number;

  // ── Temporal ──
  hourOfDay: number;
  dayOfWeek: number;
  isWeekend: boolean;

  // ── Security signals (from rug-filter) ──
  mintEnabled: boolean;
  isHoneypot: boolean;
  isKnownRugDeployer: boolean;
  lpLocked: boolean;
  lpBurned: boolean;
  sellTax: number;
  buyTax: number;
  ownershipRenounced: boolean;
  top10HolderPct: number;
  devWalletPct: number;
  walletClusterScore: number;

  // ── Optional enrichment ──
  hasTelegram?: boolean;
  hasTwitter?: boolean;
  followerQualityScore?: number;
}

// ─── Hard Filter ─────────────────────────────────────────────────────

export enum HardRejectReason {
  MINT_ENABLED = 'MINT_ENABLED',
  HONEYPOT_DETECTED = 'HONEYPOT_DETECTED',
  KNOWN_RUG_DEPLOYER = 'KNOWN_RUG_DEPLOYER',
  NO_LP_LOCK = 'NO_LP_LOCK',
  EXTREME_SELL_TAX = 'EXTREME_SELL_TAX',
  HOLDER_CONCENTRATION = 'HOLDER_CONCENTRATION',
  FETCH_TIMEOUT = 'FETCH_TIMEOUT',
}

export interface HardFilterResult {
  readonly passed: boolean;
  readonly score: number;        // 0 (safe) → 100 (reject)
  readonly reasons: HardRejectReason[];
  readonly latencyMs: number;
  /** Critical flags that ML can NEVER override */
  readonly isCriticalReject: boolean;
}

// ─── ML Ranker ───────────────────────────────────────────────────────

export interface MLPrediction {
  /** Short-horizon expected return (1–5 min) */
  expectedReturn: number;
  /** Probability of rug/dump (0–1) */
  rugProbability: number;
  /** Volatility-adjusted edge */
  volatilityAdjustedEdge: number;
  /** Model self-reported confidence (0–1) */
  confidence: number;
}

export interface RankedOpportunity {
  readonly signal: TokenSignal;
  readonly hardFilter: HardFilterResult;
  readonly prediction: MLPrediction;

  /** expectedReturn * (1 - rugProbability) * confidence */
  readonly expectedEdge: number;

  // ── Ranking sub-scores (each 0–1, higher = better) ──
  readonly liquidityQuality: number;
  readonly launchFreshness: number;
  readonly regimeFit: number;

  /** Composite rank score (higher = better opportunity) */
  readonly compositeRank: number;
}

// ─── Regime Detector ─────────────────────────────────────────────────

export enum MarketRegime {
  ACCELERATING = 'ACCELERATING',
  NORMAL = 'NORMAL',
  FRAGILE = 'FRAGILE',
  STRESS = 'STRESS',
}

export interface RegimeSnapshot {
  readonly regime: MarketRegime;
  readonly recentWinRate: number;
  readonly recentSharpe: number;
  readonly drawdownSlope: number;
  readonly slippageTrend: number;
  readonly failedFillRate: number;
  readonly tokenLaunchQuality: number;
  readonly confidence: number;
  readonly timestamp: number;
}

export interface RegimeMultipliers {
  /** Position size multiplier */
  readonly sizeMultiplier: number;
  /** ML score threshold adjustment */
  readonly scoreThresholdOffset: number;
  /** Max concurrent trades cap */
  readonly concurrencyMultiplier: number;
  /** Risk-per-trade multiplier */
  readonly riskMultiplier: number;
}

// ─── Dynamic Position Sizing ─────────────────────────────────────────

export enum SizingBucket {
  ULTRA_FAST_SNIPE = 'ULTRA_FAST_SNIPE',
  FAST_REACT = 'FAST_REACT',
  LATE_MOMENTUM = 'LATE_MOMENTUM',
  RECOVERY_MODE = 'RECOVERY_MODE',
}

export interface SizingRequest {
  readonly opportunity: RankedOpportunity;
  readonly regime: RegimeSnapshot;
  readonly currentEquity: number;
  readonly currentDrawdownPct: number;
  readonly openExposurePct: number;
  readonly openPositionCount: number;
}

export interface SizingResult {
  readonly bucket: SizingBucket;
  readonly positionSizeSol: number;
  readonly riskPct: number;
  /** Whether this is a top-decile opportunity (gets aggressive sizing) */
  readonly isTopDecile: boolean;
  readonly reason: string;
  /** Scale factor applied (for feedback tracking) */
  readonly scaleFactor: number;
}

// ─── Risk Manager ────────────────────────────────────────────────────

export interface RiskConfig {
  /** Per-trade risk cap (% of equity) */
  maxRiskPerTradePct: number;
  /** Per-token total exposure cap (% of equity) */
  maxTokenExposurePct: number;
  /** Total portfolio exposure cap (% of equity) */
  maxTotalExposurePct: number;
  /** Max concurrent open trades */
  maxConcurrentTrades: number;
  /** Daily drawdown limit before kill-switch (%) */
  dailyDrawdownLimitPct: number;
  /** Rolling window drawdown limit (%) */
  rollingDrawdownLimitPct: number;
  /** Max position size in SOL */
  maxPositionSol: number;
  /** Initial bankroll in SOL */
  initialBankrollSol: number;
  /** Survival mode trigger: rolling Sharpe threshold */
  survivalSharpeThreshold: number;
  /** Survival mode trigger: consecutive losses */
  survivalConsecutiveLosses: number;
}

export interface RiskAssessment {
  readonly approved: boolean;
  readonly cappedSizeSol: number;
  readonly reason: string;
  readonly riskMode: 'NORMAL' | 'SURVIVAL' | 'DATA_ONLY' | 'KILL_SWITCH';
  readonly currentDrawdownPct: number;
  readonly openExposurePct: number;
  readonly tokenExposurePct: number;
}

export interface RiskState {
  bankrollSol: number;
  currentEquity: number;
  peakEquity: number;
  dayPeakEquity: number;
  totalPnlSol: number;
  maxDrawdownPct: number;
  dailyDrawdownPct: number;
  openPositions: TradePosition[];
  tokenExposure: Map<string, number>;
  killSwitchTriggered: boolean;
  riskMode: 'NORMAL' | 'SURVIVAL' | 'DATA_ONLY' | 'KILL_SWITCH';
  tradesBlocked: number;
  consecutiveLosses: number;
  dailyPnls: number[];
}

export interface TradePosition {
  readonly mint: string;
  readonly bucket: SizingBucket;
  readonly entrySizeSol: number;
  readonly entryTimestamp: number;
  readonly mlScore: number;
  readonly regime: MarketRegime;
}

// ─── Execution Router ────────────────────────────────────────────────

export interface ExecutionOrder {
  readonly mint: string;
  readonly action: 'BUY' | 'SELL';
  readonly sizeSol: number;
  readonly bucket: SizingBucket;
  readonly regime: MarketRegime;
  readonly mlScore: number;
  readonly expectedEdge: number;
  readonly priority: number;  // lower = higher priority
  readonly maxSlippagePct: number;
  readonly deadlineMs: number;
  /** Jito tip in SOL (for fast execution) */
  readonly jitoTipSol?: number;
}

export interface ExecutionResult {
  readonly order: ExecutionOrder;
  readonly filled: boolean;
  readonly fillSizeSol: number;
  readonly slippagePct: number;
  readonly latencyMs: number;
  readonly txHash?: string;
  readonly error?: string;
}

// ─── Feedback & Retraining ───────────────────────────────────────────

export interface TradeOutcome {
  readonly mint: string;
  readonly entryTimestamp: number;
  readonly exitTimestamp: number;
  readonly entrySizeSol: number;
  readonly pnlSol: number;
  readonly pnlPct: number;
  readonly holdTimeMs: number;
  readonly slippageEntry: number;
  readonly slippageExit: number;
  readonly fillQuality: number;
  readonly bucket: SizingBucket;
  readonly regime: MarketRegime;
  readonly mlScoreAtEntry: number;
  readonly expectedEdgeAtEntry: number;
}

export interface FeedbackRecord {
  readonly outcome: TradeOutcome;
  readonly regimeAtEntry: RegimeSnapshot;
  readonly regimeAtExit: RegimeSnapshot;
  readonly hardFilterResultAtEntry: HardFilterResult;
  readonly predictionAtEntry: MLPrediction;
  /** Derived: was the ML prediction directionally correct? */
  readonly mlCorrect: boolean;
  /** Derived: realized edge vs expected edge */
  readonly edgeRealizationRatio: number;
}

export interface RetrainRequest {
  readonly feedbackRecords: FeedbackRecord[];
  readonly retrainTarget: 'ML_RANKER' | 'HARD_FILTER_WEIGHTS' | 'SIZING_RULES';
  readonly currentRegime: RegimeSnapshot;
}

// ─── Scenario Testing ────────────────────────────────────────────────

export interface ScenarioConfig {
  readonly name: string;
  readonly description: string;
  readonly durationMs: number;
  readonly tokenCount: number;
  readonly rugRate: number;
  readonly volatilityMultiplier: number;
  readonly launchRatePerMin: number;
  readonly slippageBase: number;
  readonly regimeSchedule: Array<{
    atMs: number;
    regime: MarketRegime;
  }>;
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly totalTrades: number;
  readonly tradesPerHour: number;
  readonly grossPnlSol: number;
  readonly netPnlSol: number;
  readonly sharpe: number;
  readonly maxDrawdownPct: number;
  readonly winRate: number;
  readonly fillRate: number;
  readonly avgLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly regimeBreakdown: Record<MarketRegime, {
    trades: number;
    pnl: number;
    winRate: number;
  }>;
  readonly bucketBreakdown: Record<SizingBucket, {
    trades: number;
    pnl: number;
    avgSize: number;
  }>;
}

// ─── Pipeline Composites ────────────────────────────────────────────

export interface PipelineDecision {
  readonly signal: TokenSignal;
  readonly hardFilter: HardFilterResult;
  readonly prediction: MLPrediction | null;
  readonly ranked: RankedOpportunity | null;
  readonly regime: RegimeSnapshot;
  readonly sizing: SizingResult | null;
  readonly risk: RiskAssessment;
  readonly order: ExecutionOrder | null;
  readonly execution: ExecutionResult | null;
  readonly stage: PipelineStage;
  readonly decisionTimestamp: number;
  readonly totalLatencyMs: number;
}

// ─── Summary Report ──────────────────────────────────────────────────

export interface DailySummary {
  readonly date: string;
  readonly totalSignals: number;
  readonly hardFilterRejects: number;
  readonly mlRanked: number;
  readonly tradesExecuted: number;
  readonly grossPnlSol: number;
  readonly netPnlSol: number;
  readonly grossPnlUsd: number;
  readonly netPnlUsd: number;
  readonly winRate: number;
  readonly sharpe: number;
  readonly maxDrawdownPct: number;
  readonly avgLatencyMs: number;
  readonly regimeBreakdown: Record<MarketRegime, number>;
  readonly tradingHours: number;
  readonly throughputPerHour: number;
  readonly riskMode: string;
  readonly killSwitchEvents: number;
}
