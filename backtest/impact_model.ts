export interface AmmPoolState {
  inputReserve: number;
  outputReserve: number;
  feeBps?: number;
}

export interface SwapImpactRequest extends AmmPoolState {
  inputAmount: number;
  maxSlippagePct?: number;
  allowPartialFill?: boolean;
}

export interface SwapImpactResult {
  accepted: boolean;
  inputAmount: number;
  outputAmount: number;
  slippagePct: number;
  priceImpactPct: number;
  partialFill: boolean;
  reason: string;
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

export const constantProductOutput = (
  inputAmount: number,
  inputReserve: number,
  outputReserve: number,
  feeBps = 30
): number => {
  if (inputAmount <= 0 || inputReserve <= 0 || outputReserve <= 0) {
    return 0;
  }
  const effectiveInput = inputAmount * (1 - feeBps / 10_000);
  return outputReserve - (inputReserve * outputReserve) / (inputReserve + effectiveInput);
};

export const simulateAmmSwap = (request: SwapImpactRequest): SwapImpactResult => {
  const maxSlippagePct = request.maxSlippagePct ?? 3;
  const feeBps = request.feeBps ?? 30;
  const evaluate = (inputAmount: number): SwapImpactResult => {
    const outputAmount = constantProductOutput(inputAmount, request.inputReserve, request.outputReserve, feeBps);
    const spotOutput = inputAmount * (request.outputReserve / Math.max(request.inputReserve, 1e-12));
    const priceImpactPct = outputAmount > 0 ? Math.max(0, (spotOutput / outputAmount - 1) * 100) : 100;
    const unitSlippagePct = outputAmount > 0 ? Math.max(0, (inputAmount / outputAmount - 1) * 100) : 100;
    const slippagePct = priceImpactPct;
    return {
      accepted: slippagePct <= maxSlippagePct,
      inputAmount,
      outputAmount,
      slippagePct,
      priceImpactPct: Math.max(priceImpactPct, unitSlippagePct),
      partialFill: false,
      reason: slippagePct <= maxSlippagePct ? "accepted" : "slippage_exceeds_limit"
    };
  };

  const full = evaluate(request.inputAmount);
  if (full.accepted || !request.allowPartialFill) {
    return full;
  }

  let low = 0;
  let high = request.inputAmount;
  let best = evaluate(0);
  for (let index = 0; index < 32; index += 1) {
    const mid = (low + high) / 2;
    const candidate = evaluate(mid);
    if (candidate.accepted) {
      best = candidate;
      low = mid;
    } else {
      high = mid;
    }
  }

  if (best.inputAmount <= 0) {
    return full;
  }
  return {
    ...best,
    partialFill: best.inputAmount < request.inputAmount * 0.999,
    reason: "partial_fill"
  };
};

export const poolFromPriceAndLiquidity = (priceSol: number, liquiditySol: number): AmmPoolState => {
  const inputReserve = Math.max(liquiditySol / 2, 0.001);
  const outputReserve = Math.max(inputReserve / Math.max(priceSol, 1e-12), 1e-9);
  return {
    inputReserve: clamp(inputReserve, 0.001, Number.MAX_SAFE_INTEGER),
    outputReserve,
    feeBps: 30
  };
};
