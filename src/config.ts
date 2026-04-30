export type RuntimeMode = "paper" | "live";
export type MarketRegime = "normal" | "caution" | "stress" | "burst";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RpcConfig {
  httpUrls: string[];
  wsUrl?: string;
  requestTimeoutMs: number;
  maxRetries: number;
}

export interface JitoConfig {
  blockEngineUrl: string;
  authUuid?: string;
  minTipSol: number;
  maxTipSol: number;
  tipFloorUrl: string;
  bundleOnly: boolean;
}

export interface RiskConfig {
  startingCapitalSol: number;
  maxPositionFraction: number;
  kellyFraction: number;
  maxTotalExposureFraction: number;
  maxDrawdownCircuitBreakerPct: number;
  dailyDrawdownCircuitBreakerPct: number;
  volatilitySpikeBlock: number;
  minTradeSol: number;
  maxOpenPositions: number;
  baseStopLossPct: number;
  baseTakeProfitPct: number;
  consecutiveLossCircuitBreaker: number;
}

export interface ScorerConfig {
  modelPath: string;
  rugcheckEnabled: boolean;
  rugcheckApiUrl: string;
  rugcheckApiKey?: string;
  rugProbBlockThreshold: number;
  rugPullBlockThreshold: number;
  minLpBurnPct: number;
  honeypotRiskThreshold: number;
  maxTransferTaxPct: number;
  deployerBlacklist: Set<string>;
}

export interface WalletConfig {
  masterPublicKey?: string;
  satelliteWalletsJson?: string;
  rotationCount: number;
  redisUrl?: string;
}

export interface ThroughputConfig {
  targetEventsPerHour: number;
  targetTradesPerHour: number;
  streamFanout: number;
  eventLoopBatchSize: number;
  maxQueueDepth: number;
}

export interface BotConfig {
  mode: RuntimeMode;
  liveTrading: boolean;
  logLevel: LogLevel;
  rpc: RpcConfig;
  jito: JitoConfig;
  risk: RiskConfig;
  scorer: ScorerConfig;
  wallets: WalletConfig;
  throughput: ThroughputConfig;
}

const asNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

const splitList = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
};

const normalizeMode = (value: string | undefined): RuntimeMode => {
  return value?.toLowerCase() === "live" ? "live" : "paper";
};

const normalizeLogLevel = (value: string | undefined): LogLevel => {
  const resolved = value?.toLowerCase();
  if (resolved === "debug" || resolved === "warn" || resolved === "error") {
    return resolved;
  }
  return "info";
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): BotConfig => {
  const primaryRpc = env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const rpcUrls = [...splitList(env.SOLANA_RPC_URLS), env.TITAN_RPC_URL, primaryRpc].filter((url): url is string => Boolean(url));
  const uniqueRpcUrls = Array.from(new Set(rpcUrls));
  const startingCapitalSol = asNumber(env.STARTING_CAPITAL_SOL, 10);
  const mode = normalizeMode(env.BOT_MODE);
  const liveTrading = asBool(env.LIVE_TRADING, false);

  return {
    mode,
    liveTrading,
    logLevel: normalizeLogLevel(env.LOG_LEVEL),
    rpc: {
      httpUrls: uniqueRpcUrls,
      wsUrl: env.SOLANA_WS_URL,
      requestTimeoutMs: asInt(env.RPC_TIMEOUT_MS, 1200),
      maxRetries: asInt(env.RPC_MAX_RETRIES, 3)
    },
    jito: {
      blockEngineUrl: env.JITO_BLOCK_ENGINE_URL || "https://frankfurt.mainnet.block-engine.jito.wtf",
      authUuid: env.JITO_AUTH_UUID,
      minTipSol: asNumber(env.JITO_MIN_TIP_SOL, 0.0001),
      maxTipSol: asNumber(env.JITO_MAX_TIP_SOL, 0.001),
      tipFloorUrl: env.JITO_TIP_FLOOR_URL || "https://bundles.jito.wtf/api/v1/bundles/tip_floor",
      bundleOnly: true
    },
    risk: {
      startingCapitalSol,
      maxPositionFraction: Math.min(asNumber(env.MAX_POSITION_FRACTION, 0.2), 0.2),
      kellyFraction: asNumber(env.KELLY_FRACTION, 0.2),
      maxTotalExposureFraction: asNumber(env.MAX_TOTAL_EXPOSURE_FRACTION, 0.55),
      maxDrawdownCircuitBreakerPct: asNumber(env.MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT, 30),
      dailyDrawdownCircuitBreakerPct: asNumber(env.DAILY_DRAWDOWN_CIRCUIT_BREAKER_PCT, 30),
      volatilitySpikeBlock: asNumber(env.VOLATILITY_SPIKE_BLOCK, 0.82),
      minTradeSol: asNumber(env.MIN_TRADE_SOL, 0.001),
      maxOpenPositions: asInt(env.MAX_OPEN_POSITIONS, 200),
      baseStopLossPct: asNumber(env.BASE_STOP_LOSS_PCT, 0.12),
      baseTakeProfitPct: asNumber(env.BASE_TAKE_PROFIT_PCT, 0.24),
      consecutiveLossCircuitBreaker: asInt(env.CONSECUTIVE_LOSS_CIRCUIT_BREAKER, 8)
    },
    scorer: {
      modelPath: env.RUG_MODEL_PATH || "./models/rug_model.json",
      rugcheckEnabled: asBool(env.RUGCHECK_ENABLED, false),
      rugcheckApiUrl: env.RUGCHECK_API_URL || "https://api.rugcheck.xyz",
      rugcheckApiKey: env.RUGCHECK_API_KEY,
      rugProbBlockThreshold: asNumber(env.RUG_PROB_BLOCK_THRESHOLD, 0.15),
      rugPullBlockThreshold: asNumber(env.RUG_PULL_BLOCK_THRESHOLD, 0.12),
      minLpBurnPct: asNumber(env.MIN_LP_BURN_PCT, 0.9),
      honeypotRiskThreshold: asNumber(env.HONEYPOT_RISK_THRESHOLD, 0.1),
      maxTransferTaxPct: asNumber(env.MAX_TRANSFER_TAX_PCT, 0.08),
      deployerBlacklist: new Set(splitList(env.DEPLOYER_BLACKLIST))
    },
    wallets: {
      masterPublicKey: env.MASTER_WALLET_PUBLIC_KEY,
      satelliteWalletsJson: env.SATELLITE_WALLETS_JSON,
      rotationCount: asInt(env.WALLET_ROTATION_COUNT, 200),
      redisUrl: env.REDIS_URL
    },
    throughput: {
      targetEventsPerHour: asInt(env.TARGET_EVENTS_PER_HOUR, 500000),
      targetTradesPerHour: asInt(env.TARGET_TRADES_PER_HOUR, 500),
      streamFanout: asInt(env.STREAM_FANOUT, 20),
      eventLoopBatchSize: asInt(env.EVENT_LOOP_BATCH_SIZE, 256),
      maxQueueDepth: asInt(env.MAX_QUEUE_DEPTH, 50000)
    }
  };
};
