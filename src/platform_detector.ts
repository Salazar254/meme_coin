export type LaunchPlatform = "pump_fun_bonding_curve" | "pump_fun_graduated" | "raydium_direct" | "unknown";

export interface PlatformDetectionInput {
  mint: string;
  programId?: string;
  launchPlatform?: string;
  bondingCurveSupply?: number;
  graduatedAt?: number;
  raydiumPool?: string;
  lpBurnPct?: number;
}

export interface PlatformDetection {
  platform: LaunchPlatform;
  slippageModel: "bonding_curve" | "amm";
  riskAdjustments: {
    honeypotMultiplier: number;
    liquidityRiskMultiplier: number;
    requireStrictLpLock: boolean;
  };
}

export const detectPlatform = (input: PlatformDetectionInput): PlatformDetection => {
  const platform = `${input.launchPlatform || ""} ${input.programId || ""}`.toLowerCase();
  if (platform.includes("pump") && !input.graduatedAt && !input.raydiumPool) {
    return {
      platform: "pump_fun_bonding_curve",
      slippageModel: "bonding_curve",
      riskAdjustments: {
        honeypotMultiplier: 1.25,
        liquidityRiskMultiplier: 0.75,
        requireStrictLpLock: false
      }
    };
  }
  if (platform.includes("pump") && (input.graduatedAt || input.raydiumPool)) {
    return {
      platform: "pump_fun_graduated",
      slippageModel: "amm",
      riskAdjustments: {
        honeypotMultiplier: 1,
        liquidityRiskMultiplier: 1,
        requireStrictLpLock: true
      }
    };
  }
  if (platform.includes("raydium") || input.raydiumPool) {
    return {
      platform: "raydium_direct",
      slippageModel: "amm",
      riskAdjustments: {
        honeypotMultiplier: 1,
        liquidityRiskMultiplier: 1.1,
        requireStrictLpLock: true
      }
    };
  }
  return {
    platform: "unknown",
    slippageModel: "amm",
    riskAdjustments: {
      honeypotMultiplier: 1.1,
      liquidityRiskMultiplier: 1.2,
      requireStrictLpLock: true
    }
  };
};

export const pumpFunBondingCurvePrice = (supply: number, virtualSolReserves = 30, virtualTokenReserves = 1_073_000_000): number => {
  const boundedSupply = Math.max(0, Math.min(supply, virtualTokenReserves * 0.98));
  const remainingTokens = Math.max(1, virtualTokenReserves - boundedSupply);
  return virtualSolReserves / remainingTokens;
};
