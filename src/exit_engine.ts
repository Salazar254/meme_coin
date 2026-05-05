export type ExitReason = "stop_loss" | "take_profit" | "time_to_rug_prediction" | "max_hold_time" | "none";

export interface ExitEvaluationInput {
  entryPriceSol: number;
  currentPriceSol: number;
  dynamicStop: number;
  dynamicTakeProfit: number;
  openedAt: number;
  now: number;
  maxHoldMs: number;
  timeToRugHours?: number;
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
