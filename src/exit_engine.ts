export type ExitReason = "stop_loss" | "take_profit" | "time_to_rug_prediction" | "max_hold_time" | "circuit_breaker" | "none";

export interface ExitEvaluationInput {
  entryPriceSol: number;
  currentPriceSol: number;
  dynamicStop: number;
  dynamicTakeProfit: number;
  openedAt: number;
  now: number;
  maxHoldMs: number;
  timeToRugHours?: number;
  circuitBreakerOpen?: boolean;
}

export interface ExitDecision {
  shouldExit: boolean;
  reason: ExitReason;
  targetPriceSol: number;
}

export const evaluateExit = (input: ExitEvaluationInput): ExitDecision => {
  const stopPrice = input.entryPriceSol * (1 - input.dynamicStop);
  const takeProfitPrice = input.entryPriceSol * (1 + input.dynamicTakeProfit);
  const ageMs = Math.max(0, input.now - input.openedAt);
  const ageHours = ageMs / 3_600_000;

  if (input.circuitBreakerOpen) {
    return { shouldExit: true, reason: "circuit_breaker", targetPriceSol: input.currentPriceSol };
  }
  if (input.currentPriceSol <= stopPrice) {
    return { shouldExit: true, reason: "stop_loss", targetPriceSol: input.currentPriceSol };
  }
  if (input.currentPriceSol >= takeProfitPrice) {
    return { shouldExit: true, reason: "take_profit", targetPriceSol: input.currentPriceSol };
  }
  if (input.timeToRugHours !== undefined && input.timeToRugHours - ageHours < 2) {
    return { shouldExit: true, reason: "time_to_rug_prediction", targetPriceSol: input.currentPriceSol };
  }
  if (ageMs >= input.maxHoldMs) {
    return { shouldExit: true, reason: "max_hold_time", targetPriceSol: input.currentPriceSol };
  }
  return { shouldExit: false, reason: "none", targetPriceSol: input.currentPriceSol };
};

export interface BuildExitBundleInput {
  ownerPublicKey: string;
  mint: string;
  tokenAmount: bigint;
  currentPriceSol: number;
  slippageTolerancePct: number;
  priorityFeeMicroLamports: number;
  jitoTipSol: number;
}

export interface ExitBundlePlan {
  minimumOutputSol: number;
  priorityFeeMicroLamports: number;
  jitoTipSol: number;
  transactionsBase64: string[];
}

export const computeMinimumOutputSol = (tokenAmount: number, currentPriceSol: number, slippageTolerancePct: number): number => {
  const gross = Math.max(0, tokenAmount) * Math.max(0, currentPriceSol);
  return gross * (1 - Math.max(0, slippageTolerancePct) / 100);
};

export const buildExitBundlePlan = (input: BuildExitBundleInput): ExitBundlePlan => {
  const minimumOutputSol = computeMinimumOutputSol(Number(input.tokenAmount), input.currentPriceSol, input.slippageTolerancePct);
  const payload = {
    ownerPublicKey: input.ownerPublicKey,
    mint: input.mint,
    tokenAmount: input.tokenAmount.toString(),
    minimumOutputSol,
    priorityFeeMicroLamports: input.priorityFeeMicroLamports,
    jitoTipSol: input.jitoTipSol
  };
  return {
    minimumOutputSol,
    priorityFeeMicroLamports: input.priorityFeeMicroLamports,
    jitoTipSol: input.jitoTipSol,
    transactionsBase64: [Buffer.from(JSON.stringify(payload), "utf8").toString("base64")]
  };
};
