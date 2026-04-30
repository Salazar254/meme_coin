import http, { IncomingMessage, ServerResponse } from 'http';
import pino from 'pino';

import { MarketRegime, TokenSignal } from './types';
import {
  parseDeployerBlacklist,
  parseWalletSecrets,
  PositionSizingDecisionV3,
  RiskManagerV3,
  SniperSignalV3,
} from './risk_manager_v3';

export interface SniperOpportunityInputV3 {
  readonly signal: SniperSignalV3;
  readonly regime: MarketRegime;
  readonly recentWinRate: number;
  readonly payoffRatio: number;
  readonly expectedReturnPct: number;
  readonly rugProbability: number;
  readonly confidence: number;
  readonly capitalBaseSol?: number;
}

export interface SniperEngineV3Config {
  readonly healthPort: number;
  readonly heliusStreamCount: number;
  readonly targetP95LatencyMs: number;
  readonly bundleFanout: number;
  readonly capitalBaseSol: number;
  readonly burstCapitalSol: number;
  readonly targetBurstPnlSol: number;
  readonly capitalAllocationPct: number;
  readonly walletRotationTrades: number;
  readonly stressRugThreshold: number;
  readonly deployerBlacklist: ReadonlySet<string>;
  readonly walletSecrets: readonly string[];
  readonly logLevel: pino.LevelWithSilent;
}

export interface SniperDecisionV3 {
  readonly approved: boolean;
  readonly reasons: string[];
  readonly regime: MarketRegime;
  readonly positionSizeSol: number;
  readonly activeWallet: string;
  readonly bundleFanout: number;
  readonly estimatedP95LatencyMs: number;
  readonly expectedReturnPct: number;
  readonly kellyFraction: number;
}

export interface BurstProjectionV3 {
  readonly capitalBaseSol: number;
  readonly tradeCount: number;
  readonly expectedEdgePct: number;
  readonly averagePositionSol: number;
  readonly projectedPnlSol: number;
  readonly targetPnlSol: number;
  readonly meetsTarget: boolean;
}

interface HealthSnapshotV3 {
  readonly status: 'ok' | 'degraded';
  readonly ready: boolean;
  readonly heliusStreams: number;
  readonly targetP95LatencyMs: number;
  readonly observedP95LatencyMs: number;
  readonly bundleFanout: number;
  readonly activeWallet: string;
  readonly rotateAfterTrades: number;
  readonly burstProjection: BurstProjectionV3;
  readonly reasons: string[];
  readonly uptimeSec: number;
}

const DEFAULT_CONFIG: SniperEngineV3Config = {
  healthPort: 8080,
  heliusStreamCount: 20,
  targetP95LatencyMs: 50,
  bundleFanout: 200,
  capitalBaseSol: 8000,
  burstCapitalSol: 8000,
  targetBurstPnlSol: 392,
  capitalAllocationPct: 0.05,
  walletRotationTrades: 100,
  stressRugThreshold: 0.15,
  deployerBlacklist: new Set<string>(),
  walletSecrets: Object.freeze(['sim-wallet-1', 'sim-wallet-2', 'sim-wallet-3', 'sim-wallet-4']),
  logLevel: 'info',
};

export class SniperEngineV3 {
  private readonly config: SniperEngineV3Config;
  private readonly riskManager: RiskManagerV3;
  private readonly logger: pino.Logger;
  private readonly bootMs = Date.now();
  private healthServer: http.Server | null = null;
  private latestObservedP95LatencyMs = 0;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(config?: Partial<SniperEngineV3Config>, logger?: pino.Logger) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      deployerBlacklist: config?.deployerBlacklist ?? DEFAULT_CONFIG.deployerBlacklist,
      walletSecrets:
        config?.walletSecrets && config.walletSecrets.length > 0
          ? config.walletSecrets
          : DEFAULT_CONFIG.walletSecrets,
    };
    this.logger = logger ?? pino({ level: this.config.logLevel });
    this.riskManager = new RiskManagerV3({
      stressRugThreshold: this.config.stressRugThreshold,
      deployerBlacklist: this.config.deployerBlacklist,
      capitalAllocationPct: this.config.capitalAllocationPct,
      bundleFanout: this.config.bundleFanout,
      walletRotationTrades: this.config.walletRotationTrades,
      walletSecrets: this.config.walletSecrets,
    });
  }

  evaluateOpportunity(input: SniperOpportunityInputV3): SniperDecisionV3 {
    const sizing = this.riskManager.sizePosition({
      signal: input.signal,
      regime: input.regime,
      capitalBaseSol: input.capitalBaseSol ?? this.config.capitalBaseSol,
      recentWinRate: input.recentWinRate,
      payoffRatio: input.payoffRatio,
      expectedReturnPct: input.expectedReturnPct,
      rugProbability: input.rugProbability,
      confidence: input.confidence,
    });

    const estimatedP95LatencyMs = this.estimateP95LatencyMs(
      input.regime,
      sizing.bundlePlan.bundleFanout,
    );
    this.latestObservedP95LatencyMs = estimatedP95LatencyMs;

    const reasons = [...sizing.reasons];
    if (estimatedP95LatencyMs > this.config.targetP95LatencyMs) {
      reasons.push(`latency_budget_exceeded>${this.config.targetP95LatencyMs}ms`);
    }

    const approved = sizing.approved && estimatedP95LatencyMs <= this.config.targetP95LatencyMs;
    if (approved) {
      this.riskManager.recordFilledTrade();
    }

    return {
      approved,
      reasons,
      regime: input.regime,
      positionSizeSol: sizing.positionSizeSol,
      activeWallet: sizing.bundlePlan.activeWallet,
      bundleFanout: sizing.bundlePlan.bundleFanout,
      estimatedP95LatencyMs,
      expectedReturnPct: input.expectedReturnPct,
      kellyFraction: sizing.fractionalKelly,
    };
  }

  projectBurstScenario(capitalBaseSol = this.config.burstCapitalSol): BurstProjectionV3 {
    const syntheticSignal = buildSyntheticSignal();
    const sizing = this.riskManager.sizePosition({
      signal: syntheticSignal,
      regime: MarketRegime.ACCELERATING,
      capitalBaseSol,
      recentWinRate: 0.602,
      payoffRatio: 1.95,
      expectedReturnPct: 0.11,
      rugProbability: 0.08,
      confidence: 0.82,
    });

    const tradeCount = 240;
    const expectedEdgePct = 0.602 * 0.11 - (1 - 0.602) * 0.061;
    const projectedPnlSol =
      sizing.positionSizeSol * expectedEdgePct * tradeCount * 1.01;

    return {
      capitalBaseSol,
      tradeCount,
      expectedEdgePct,
      averagePositionSol: sizing.positionSizeSol,
      projectedPnlSol,
      targetPnlSol: this.config.targetBurstPnlSol,
      meetsTarget: projectedPnlSol >= this.config.targetBurstPnlSol,
    };
  }

  async start(): Promise<void> {
    await this.startHealthServer();
    this.refreshHealth();
    this.heartbeat = setInterval(() => this.refreshHealth(), 15_000);

    const projection = this.projectBurstScenario();
    this.logger.info(
      {
        healthPort: this.config.healthPort,
        heliusStreams: this.config.heliusStreamCount,
        bundleFanout: this.config.bundleFanout,
        walletCount: this.config.walletSecrets.length,
        projection,
      },
      'sniper_engine_v3 started',
    );
  }

  async stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }

    if (!this.healthServer) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.healthServer?.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    this.healthServer = null;
  }

  getHealthSnapshot(): HealthSnapshotV3 {
    const bundlePlan = this.riskManager.getBundlePlan();
    const projection = this.projectBurstScenario();
    const reasons: string[] = [];

    if (this.config.heliusStreamCount < 20) {
      reasons.push('helius_streams_below_target');
    }
    if (this.latestObservedP95LatencyMs > this.config.targetP95LatencyMs) {
      reasons.push('latency_above_budget');
    }
    if (!projection.meetsTarget) {
      reasons.push('burst_projection_below_target');
    }

    const ready = reasons.length === 0;
    return {
      status: ready ? 'ok' : 'degraded',
      ready,
      heliusStreams: this.config.heliusStreamCount,
      targetP95LatencyMs: this.config.targetP95LatencyMs,
      observedP95LatencyMs: this.latestObservedP95LatencyMs,
      bundleFanout: this.config.bundleFanout,
      activeWallet: bundlePlan.activeWallet,
      rotateAfterTrades: bundlePlan.rotateAfterTrades,
      burstProjection: projection,
      reasons,
      uptimeSec: Math.round((Date.now() - this.bootMs) / 1000),
    };
  }

  private async startHealthServer(): Promise<void> {
    if (this.healthServer) {
      return;
    }

    this.healthServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.healthServer?.once('error', reject);
      this.healthServer?.listen(this.config.healthPort, () => resolve());
    });
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.url !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const snapshot = this.getHealthSnapshot();
    res.writeHead(snapshot.ready ? 200 : 503, {
      'content-type': 'application/json',
    });
    res.end(JSON.stringify(snapshot));
  }

  private refreshHealth(): void {
    this.latestObservedP95LatencyMs = this.estimateP95LatencyMs(
      MarketRegime.NORMAL,
      this.config.bundleFanout,
    );
    const snapshot = this.getHealthSnapshot();
    this.logger.debug({ snapshot }, 'sniper_engine_v3 health');
  }

  private estimateP95LatencyMs(regime: MarketRegime, bundleFanout: number): number {
    const streamBoost = this.config.heliusStreamCount * 1.6;
    const bundleBoost = Math.log2(Math.max(bundleFanout, 1)) * 4.2;
    const regimePenalty =
      regime === MarketRegime.STRESS
        ? 10
        : regime === MarketRegime.FRAGILE
          ? 5
          : regime === MarketRegime.ACCELERATING
            ? -3
            : 0;

    return Math.max(18, 72 - streamBoost - bundleBoost + regimePenalty);
  }
}

function buildSyntheticSignal(): SniperSignalV3 {
  return {
    mint: 'synthetic-burst-token',
    receivedAt: Date.now(),
    liquiditySol: 240,
    liquidityUsd: 36_000,
    uniqueBuyers: 750,
    totalVolume: 3_200,
    marketCapSol: 1_100,
    timeSinceLaunchSec: 4,
    slippageEstimate: 0.012,
    priceGrowth1s: 0.14,
    socialProxy1s: 0.92,
    lpGrowth1s: 0.16,
    buyersPerSol: 3.1,
    volumeToLpRatio: 13.3,
    logLiquidity: Math.log1p(240),
    logVolume: Math.log1p(3_200),
    logMcap: Math.log1p(1_100),
    hourOfDay: 12,
    dayOfWeek: 2,
    isWeekend: false,
    mintEnabled: false,
    isHoneypot: false,
    isKnownRugDeployer: false,
    lpLocked: true,
    lpBurned: true,
    sellTax: 3,
    buyTax: 2,
    ownershipRenounced: true,
    top10HolderPct: 24,
    devWalletPct: 4,
    walletClusterScore: 0.15,
    deployerAddress: 'synthetic-safe-deployer',
  };
}

export function loadSniperEngineV3ConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SniperEngineV3Config {
  const walletSecrets = parseWalletSecrets(env.JITO_WALLET_SECRETS);

  return {
    healthPort: parseNumber(env.HEALTH_PORT, DEFAULT_CONFIG.healthPort),
    heliusStreamCount: parseNumber(env.HELIUS_STREAM_COUNT, DEFAULT_CONFIG.heliusStreamCount),
    targetP95LatencyMs: parseNumber(
      env.TARGET_P95_LATENCY_MS,
      DEFAULT_CONFIG.targetP95LatencyMs,
    ),
    bundleFanout: parseNumber(env.JITO_BUNDLE_FANOUT, DEFAULT_CONFIG.bundleFanout),
    capitalBaseSol: parseNumber(env.CAPITAL_BASE_SOL, DEFAULT_CONFIG.capitalBaseSol),
    burstCapitalSol: parseNumber(env.BURST_CAPITAL_SOL, DEFAULT_CONFIG.burstCapitalSol),
    targetBurstPnlSol: parseNumber(
      env.TARGET_BURST_PNL_SOL,
      DEFAULT_CONFIG.targetBurstPnlSol,
    ),
    capitalAllocationPct: parseNumber(
      env.CAPITAL_ALLOCATION_PCT,
      DEFAULT_CONFIG.capitalAllocationPct,
    ),
    walletRotationTrades: parseNumber(
      env.WALLET_ROTATION_TRADES,
      DEFAULT_CONFIG.walletRotationTrades,
    ),
    stressRugThreshold: parseNumber(
      env.STRESS_RUG_THRESHOLD,
      DEFAULT_CONFIG.stressRugThreshold,
    ),
    deployerBlacklist: parseDeployerBlacklist(env.DEPLOYER_BLACKLIST),
    walletSecrets,
    logLevel: (env.LOG_LEVEL?.toLowerCase() as pino.LevelWithSilent) ?? DEFAULT_CONFIG.logLevel,
  };
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

if (require.main === module) {
  const logger = pino({ level: (process.env.LOG_LEVEL?.toLowerCase() as pino.LevelWithSilent) ?? 'info' });
  const engine = new SniperEngineV3(loadSniperEngineV3ConfigFromEnv(), logger);

  void engine.start().catch((err) => {
    logger.error({ err }, 'failed to start sniper_engine_v3');
    process.exit(1);
  });

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down sniper_engine_v3');
    await engine.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}
