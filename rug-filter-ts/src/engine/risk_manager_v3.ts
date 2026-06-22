import { MarketRegime, TokenSignal } from './types';

export interface SniperSignalV3 extends TokenSignal {
  deployerAddress?: string;
}

export interface RiskManagerV3Config {
  readonly stressRugThreshold: number;
  readonly requireLpBurnInStress: boolean;
  readonly deployerBlacklist: ReadonlySet<string>;
  readonly capitalAllocationPct: number;
  readonly kellyFraction: number;
  readonly regimeFactors: Readonly<Record<MarketRegime, number>>;
  readonly maxPositionSol: number;
  readonly bundleFanout: number;
  readonly walletRotationTrades: number;
  readonly walletSecrets: readonly string[];
}

export interface PositionSizingInputV3 {
  readonly signal: SniperSignalV3;
  readonly regime: MarketRegime;
  readonly capitalBaseSol: number;
  readonly recentWinRate: number;
  readonly payoffRatio: number;
  readonly expectedReturnPct: number;
  readonly rugProbability: number;
  readonly confidence: number;
}

export interface StressGuardResultV3 {
  readonly approved: boolean;
  readonly reasons: string[];
}

export interface BundleExecutionPlanV3 {
  readonly activeWallet: string;
  readonly walletIndex: number;
  readonly bundleFanout: number;
  readonly rotateAfterTrades: number;
}

export interface PositionSizingDecisionV3 {
  readonly approved: boolean;
  readonly reasons: string[];
  readonly positionSizeSol: number;
  readonly regimeFactor: number;
  readonly capitalAllocationSol: number;
  readonly fractionalKelly: number;
  readonly bundlePlan: BundleExecutionPlanV3;
}

const DEFAULT_CONFIG: RiskManagerV3Config = {
  stressRugThreshold: 0.15,
  requireLpBurnInStress: true,
  deployerBlacklist: new Set<string>(),
  capitalAllocationPct: 0.05,
  kellyFraction: 0.2,
  regimeFactors: {
    [MarketRegime.ACCELERATING]: 1.25,
    [MarketRegime.NORMAL]: 1.0,
    [MarketRegime.FRAGILE]: 0.55,
    [MarketRegime.STRESS]: 0.18,
  },
  maxPositionSol: 250,
  bundleFanout: 200,
  walletRotationTrades: 100,
  walletSecrets: Object.freeze(['sim-wallet-1']),
};

export class RiskManagerV3 {
  private readonly config: RiskManagerV3Config;
  private activeWalletIndex = 0;
  private filledTrades = 0;

  constructor(config?: Partial<RiskManagerV3Config>) {
    const walletSecrets =
      config?.walletSecrets && config.walletSecrets.length > 0
        ? [...config.walletSecrets]
        : [...DEFAULT_CONFIG.walletSecrets];

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      regimeFactors: {
        ...DEFAULT_CONFIG.regimeFactors,
        ...(config?.regimeFactors ?? {}),
      },
      deployerBlacklist: config?.deployerBlacklist ?? DEFAULT_CONFIG.deployerBlacklist,
      walletSecrets,
    };
  }

  evaluateStressGuard(
    signal: SniperSignalV3,
    regime: MarketRegime,
    rugProbability: number,
  ): StressGuardResultV3 {
    const reasons: string[] = [];
    const deployerId = signal.deployerAddress ?? signal.mint;

    if (signal.isKnownRugDeployer || this.config.deployerBlacklist.has(deployerId)) {
      reasons.push('deployer_blacklist');
    }

    if (regime === MarketRegime.STRESS) {
      if (rugProbability > this.config.stressRugThreshold) {
        reasons.push(`stress_rug_threshold>${this.config.stressRugThreshold.toFixed(2)}`);
      }

      if (this.config.requireLpBurnInStress && !signal.lpBurned) {
        reasons.push('stress_lp_burn_required');
      }
    }

    return {
      approved: reasons.length === 0,
      reasons,
    };
  }

  sizePosition(input: PositionSizingInputV3): PositionSizingDecisionV3 {
    const stressGuard = this.evaluateStressGuard(
      input.signal,
      input.regime,
      input.rugProbability,
    );
    if (!stressGuard.approved) {
      return {
        approved: false,
        reasons: stressGuard.reasons,
        positionSizeSol: 0,
        regimeFactor: this.config.regimeFactors[input.regime],
        capitalAllocationSol: 0,
        fractionalKelly: 0,
        bundlePlan: this.getBundlePlan(),
      };
    }

    const regimeFactor = this.config.regimeFactors[input.regime];
    const confidenceWeight = clamp(0.65 + input.confidence * 0.5, 0.65, 1.15);
    const capitalAllocationSol =
      input.capitalBaseSol * this.config.capitalAllocationPct * confidenceWeight;
    const fractionalKelly = this.computeFractionalKelly(
      input.recentWinRate,
      input.payoffRatio,
      input.expectedReturnPct,
      input.rugProbability,
    );

    const rawSize = regimeFactor * capitalAllocationSol * fractionalKelly;
    const positionSizeSol = clamp(rawSize, 0, this.config.maxPositionSol);
    const reasons =
      positionSizeSol > 0
        ? [
            `regime_factor=${regimeFactor.toFixed(2)}`,
            `capital_alloc=${capitalAllocationSol.toFixed(4)}`,
            `kelly_fraction=${fractionalKelly.toFixed(4)}`,
          ]
        : ['kelly_size_zero'];

    return {
      approved: positionSizeSol > 0,
      reasons,
      positionSizeSol,
      regimeFactor,
      capitalAllocationSol,
      fractionalKelly,
      bundlePlan: this.getBundlePlan(),
    };
  }

  recordFilledTrade(): void {
    this.filledTrades++;
    if (this.filledTrades % this.config.walletRotationTrades === 0) {
      this.activeWalletIndex =
        (this.activeWalletIndex + 1) % this.config.walletSecrets.length;
    }
  }

  getBundlePlan(): BundleExecutionPlanV3 {
    return {
      activeWallet: this.config.walletSecrets[this.activeWalletIndex],
      walletIndex: this.activeWalletIndex,
      bundleFanout: this.config.bundleFanout,
      rotateAfterTrades:
        this.config.walletRotationTrades -
        (this.filledTrades % this.config.walletRotationTrades),
    };
  }

  getStats(): Record<string, unknown> {
    return {
      filledTrades: this.filledTrades,
      activeWallet: this.config.walletSecrets[this.activeWalletIndex],
      activeWalletIndex: this.activeWalletIndex,
      walletCount: this.config.walletSecrets.length,
      bundleFanout: this.config.bundleFanout,
      walletRotationTrades: this.config.walletRotationTrades,
      stressRugThreshold: this.config.stressRugThreshold,
      capitalAllocationPct: this.config.capitalAllocationPct,
      kellyFraction: this.config.kellyFraction,
    };
  }

  private computeFractionalKelly(
    recentWinRate: number,
    payoffRatio: number,
    expectedReturnPct: number,
    rugProbability: number,
  ): number {
    const winRate = clamp(recentWinRate, 0.05, 0.95);
    const safePayoff = Math.max(payoffRatio, 0.5);
    const fullKelly = Math.max(0, winRate - (1 - winRate) / safePayoff);
    const edgeWeight = clamp(0.75 + expectedReturnPct * 2.5 - rugProbability, 0.1, 1.2);
    return clamp(fullKelly * this.config.kellyFraction * edgeWeight, 0, 1);
  }
}

export function parseDeployerBlacklist(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set<string>();
  }

  return new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

export function parseWalletSecrets(raw: string | undefined): string[] {
  if (!raw) {
    return ['sim-wallet-1', 'sim-wallet-2', 'sim-wallet-3', 'sim-wallet-4'];
  }

  const wallets = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return wallets.length > 0
    ? wallets
    : ['sim-wallet-1', 'sim-wallet-2', 'sim-wallet-3', 'sim-wallet-4'];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
