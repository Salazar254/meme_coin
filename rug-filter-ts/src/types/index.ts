/**
 * src/types/index.ts
 *
 * Core interfaces and types for the rug filter ML system.
 * Matches hedge-fund risk management principles and cognitive architecture.
 */

/**
 * SIGNAL VECTOR
 * All security signals for a token. No optional fields in core interfaces.
 * null/unknown values become +5 risk penalty during scoring.
 */

// GoPlus Security API response
export interface GoPlusSignals {
  mintEnabled: boolean;
  blacklistFunction: boolean;
  ownershipRenounced: boolean;
  isProxy: boolean;
}

// honeypot.is API response
export interface HoneypotSignals {
  isHoneypot: boolean;
  buyTax: number; // 0-100 basis points
  sellTax: number; // 0-100 basis points
}

// Helius RPC or Alchemy holder metrics
export interface HolderMetrics {
  top10HolderPct: number; // 0-100%
  devWalletPct: number; // 0-100%
  walletClusterScore: number; // 0-1 (0 = unique, 1 = concentrated)
}

// Unicrypt or DappRadar LP data
export interface LiquiditySignals {
  lpLocked: boolean;
  lpLockDays: number; // 0 = unlocked
  lpBurned: boolean;
}

// Social/community signals
export interface SocialSignals {
  hasTelegram: boolean;
  hasTwitter: boolean;
  telegramAgeDays: number;
  twitterAgeDays: number;
  followerQualityScore: number; // 0-1 (0 = bots, 1 = organic)
}

// Internal blacklist lookup
export interface InternalSecurityFlags {
  isKnownRugDeployer: boolean;
}

/**
 * Complete signal vector for a token.
 * Required TypeScript: all fields present, never undefined.
 */
export interface SignalVector {
  tokenAddress: string;
  timestamp: number;
  
  // GoPlus
  mintEnabled: boolean;
  blacklistFunction: boolean;
  ownershipRenounced: boolean;
  isProxy: boolean;
  
  // Honeypot
  isHoneypot: boolean;
  buyTax: number;
  sellTax: number;
  
  // Holders
  top10HolderPct: number;
  devWalletPct: number;
  walletClusterScore: number;
  
  // Liquidity
  lpLocked: boolean;
  lpLockDays: number;
  lpBurned: boolean;
  
  // Social
  hasTelegram: boolean;
  hasTwitter: boolean;
  telegramAgeDays: number;
  twitterAgeDays: number;
  followerQualityScore: number;
  
  // Internal
  isKnownRugDeployer: boolean;
  
  // Metadata
  sourceChain: 'solana' | 'ethereum' | 'polygon' | 'unknown';
  detectedAt: number; // unix timestamp (ms)
}

/**
 * ANOMALY DETECTOR OUTPUT
 * Autoencoder reconstruction error + novel pattern flag
 */
export interface AnomalyScore {
  reconstructionError: number; // 0-1
  isAnomaly: boolean; // true if > 0.7
  noveltyFlag: string;
}

/**
 * SPECIALIST MODEL OUTPUT
 * Each specialist returns score + confidence
 */
export interface SpecialistPrediction {
  modelName: 'ContractModel' | 'WalletModel' | 'LiquidityModel' | 'SocialModel';
  score: number; // 0-1 (0 = safe, 1 = rug)
  confidence: number; // 0-1
  reasoning?: string;
}

/**
 * ENSEMBLE RESULT
 * Combined output from all four specialists
 */
export interface EnsembleResult {
  contractPred: SpecialistPrediction;
  walletPred: SpecialistPrediction;
  liquidityPred: SpecialistPrediction;
  socialPred: SpecialistPrediction;
  ensembleScore: number; // 0-1 (weighted)
  confidenceAdjustedScore: number; // confidence-weighted
  conflictFlag?: boolean; // true if top 2 models disagree > 30pts
}

/**
 * HARD RULE ENGINE OUTPUT
 * Rule-based scoring (runs before ML)
 */
export interface HardRuleResult {
  shouldRejectImmediately: boolean;
  ruleScore: number; // 0-100
  violatedRules: string[];
}

/**
 * FINAL RUG FILTER DECISION
 * Combines rule score + ensemble score + anomaly confidence calibration
 */
export interface RugFilterDecision {
  tokenAddress: string;
  timestamp: number;
  
  // Scoring components
  hardRuleScore: number; // 0-100
  ensembleScore: number; // 0-100
  anomalyScore: number; // 0-1
  finalScore: number; // 0-100 (60% rule + 40% ensemble)
  
  // Decision
  decision: 'REJECT' | 'SKIP' | 'SMALL' | 'BUY';
  riskLevel: 'REJECT' | 'HIGH' | 'MEDIUM' | 'LOW_MEDIUM' | 'LOW';
  
  // Sizing
  positionSize: number; // 0-1.0 (fraction of capital)
  riskAdjustment?: number; // 0-1 (DD-linked reduction)
  
  // Metadata
  conflictFlag?: boolean;
  anomalyFlag?: boolean;
  regimeShiftFlag?: boolean;
  confidence: number; // 0-1
  
  // Debug
  signalVector: SignalVector;
  ensemble: EnsembleResult;
}

/**
 * REGIME DETECTOR OUTPUT
 * Monitors rug-pattern shifts and suggests retraining
 */
export interface RegimeState {
  currentRegime: 'STABLE' | 'SHIFTING' | 'ANOMALOUS';
  
  // Miss rate (rugs that bypassed filter)
  missRate48h: number; // 0-1
  missRatePriorWeek: number; // 0-1
  missRateIncrease: number; // (48h - 1week) / 1week
  
  // Signal decay (information gain drop)
  decayingSignals: Array<{
    signal: string;
    informatinGainDrop: number; // 0-1
  }>;
  
  // Regime metadata
  shiftDetected: boolean;
  confidenceInDetection: number; // 0-1
  suggestRetrain: boolean;
  lastSwitchTimestamp: number;
}

/**
 * CONFIDENCE CALIBRATOR OUTPUT
 * Decision + position size based on score curve
 */
export interface CalibrationResult {
  decision: 'REJECT' | 'SKIP' | 'SMALL' | 'BUY';
  positionSize: number; // 0-1.0
  riskLevel: 'REJECT' | 'HIGH' | 'MEDIUM' | 'LOW_MEDIUM' | 'LOW';
  scoreRange: [number, number]; // score bins used for decision
}

/**
 * FEEDBACK RECORD
 * Logs decision + 48h outcome for continual learning
 */
export interface FeedbackRecord {
  id?: number; // DB primary key
  tokenAddress: string;
  timestamp: number;
  
  // Decision details (at time of decision)
  signalVector: SignalVector;
  decision: RugFilterDecision;
  
  // Outcome (labeled 48h later)
  outcome?: 'RUG' | 'DUMP_60' | 'STABLE' | 'MOONSHOT';
  price48hLater?: number;
  pricePeakPrice?: number;
  pricePeakTime?: number;
  
  // Rich reward signal
  rewardSignal?: number; // -1.0 to +1.0
  
  // Label status
  labeled: boolean;
  labeledAt?: number;
  
  // Persist timestamp
  createdAt: number;
}

/**
 * RETRAIN REPORT
 * Logged after each continual learning cycle
 */
export interface RetrainReport {
  retrainCycle: number;
  timestamp: number;
  
  // Data
  trainingRecords: number;
  validationRecords: number;
  labeledRecords: number;
  
  // Performance before / after
  modelAccuracyBefore: number; // 0-1
  modelAccuracyAfter: number; // 0-1
  accuracyDelta: number; // signed
  validationAccuracy: number;
  
  // Specialist deltas
  specialistDeltas: Record<string, {
    modelName: string;
    accuracyBefore: number;
    accuracyAfter: number;
    deltaAccuracy: number;
  }>;
  
  // EWC Fisher info
  ewcFisherStats?: {
    meanFisherWeight: number;
    stdFisherWeight: number;
    largeWeightPct: number; // % of weights with Fisher > P95
  };
  
  // Regime
  regimeState: RegimeState;
  
  // Deployed?
  deployed: boolean;
}

/**
 * MEMORY TIER (3-tier cognitive architecture)
 */

export interface LongTermMemory {
  // Fundamental signals with high EWC protection
  // (rarely updated, slow learning)
  
  // Trained weights + Fisher matrix
  contractModelWeights?: Record<string, number>;
  honeypotDetectionThreshold?: number;
  lpLockMinDays?: number;
  
  lastUpdateTimestamp: number;
  frozenUntil?: number; // EWC protection window
}

export interface MediumTermMemory {
  // Holder patterns, deployer clusters
  // (monthly retraining, moderate EWC)
  
  knownRugDeployers: Set<string>;
  knownWhitelisted: Set<string>;
  clusterData?: Record<string, any>;
  
  lastUpdateTimestamp: number;
  retrainCycle: number;
}

export interface ShortTermMemory {
  // Real-time blacklist, recent clusters
  // (no retraining, can override MTM/LTM)
  
  emergingBadClusterWallets: Set<string>;
  recent24hRugs: Map<string, number>; // address -> rugged_timestamp
  anomalyBlacklist: Set<string>;
  
  ttlTimestamp: number; // reset daily
}

/**
 * ORCHESTRATOR STATE
 * Main system configuration + runtime state
 */
export interface RugFilterConfig {
  // API keys + endpoints
  goPlusApiKey?: string;
  honeypotApiKey?: string;
  heliusApiKey?: string;
  alchemyApiKey?: string;
  unicryptApiKey?: string;
  
  // Model paths (local or HTTP endpoint)
  anomalyDetectorModelPath: string; // Python model artifact
  contractModelPath: string;
  walletModelPath: string;
  liquidityModelPath: string;
  socialModelPath: string;
  
  // ML runtime (Python subprocess or direct HTTP)
  pythonRuntimePath: string;
  pythonModelServerUrl?: string;
  
  // Database
  feedbackDbPath: string;
  
  // Redis (optional, for caching)
  redisUrl?: string;
  
  // Execution
  signalExtractionTimeout: number; // ms
  apiCallTimeout: number; // ms per API
  maxConcurrentApis: number;
  
  // Thresholds
  anomalyThreshold: number; // 0.7
  conflictThreshold: number; // 30 pts
  
  // Retraining
  retrainIntervalDays: number;
  minFeedbackRecordsForRetrain: number;
  ewcFisherPenaltyFactor: number;
  
  // DD linkage
  maxDrawdownPct: number; // 30-35%
  
  // Logging
  logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  logPath?: string;
}

/**
 * POSITION SIZING CONTEXT
 * Real-time portfolio state for DD-linked sizing
 */
export interface PortfolioContext {
  currentDrawdownPct: number; // 0-100
  peakCapital: number;
  currentCapital: number;
  openPositions: number;
  maxOpenPositions: number;
  dailyPnL: number;
  sharpeRatio: number;
}

/**
 * RULE VIOLATION
 * Specific hard rule that was violated
 */
export enum HardRule {
  MINT_ENABLED = 'MINT_ENABLED',
  HONEYPOT_DETECTED = 'HONEYPOT_DETECTED',
  KNOWN_RUG_DEPLOYER = 'KNOWN_RUG_DEPLOYER',
  NO_LP_LOCKED_OR_BURNED = 'NO_LP_LOCKED_OR_BURNED',
  SELL_TAX_TOO_HIGH = 'SELL_TAX_TOO_HIGH',
  OWNERSHIP_NOT_RENOUNCED = 'OWNERSHIP_NOT_RENOUNCED',
}

/**
 * API RESPONSE TYPES (normalized)
 */

export interface ApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  fetchTimeMs: number;
  source: string;
}

export interface NormalizedSignalResult {
  signals: SignalVector;
  missingFields: string[]; // fields that failed to fetch
  fetchTimeMs: number;
}
