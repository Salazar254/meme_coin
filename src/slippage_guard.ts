export interface JupiterQuote {
  outAmount: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string;
}

export interface SlippageGuardRequest {
  inputMint: string;
  outputMint: string;
  amountLamports: bigint;
  expectedOutAmount: bigint;
  maxDeviationPct?: number;
  slippageBps?: number;
  quoteApiBaseUrl?: string;
}

export interface SlippageGuardResult {
  accepted: boolean;
  reason: string;
  quotedOutAmount: bigint;
  deviationPct: number;
}

export const checkJupiterSlippage = async (request: SlippageGuardRequest): Promise<SlippageGuardResult> => {
  const baseUrl = request.quoteApiBaseUrl || "https://quote-api.jup.ag/v6/quote";
  const url = new URL(baseUrl);
  url.searchParams.set("inputMint", request.inputMint);
  url.searchParams.set("outputMint", request.outputMint);
  url.searchParams.set("amount", request.amountLamports.toString());
  url.searchParams.set("slippageBps", String(request.slippageBps ?? 100));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { accepted: false, reason: `jupiter_quote_http_${response.status}`, quotedOutAmount: 0n, deviationPct: 100 };
    }
    const quote = await response.json() as JupiterQuote;
    const quotedOutAmount = BigInt(quote.outAmount || "0");
    const expected = Number(request.expectedOutAmount);
    const actual = Number(quotedOutAmount);
    const deviationPct = expected > 0 ? Math.abs(actual - expected) / expected * 100 : 100;
    const accepted = deviationPct <= (request.maxDeviationPct ?? 1);
    return {
      accepted,
      reason: accepted ? "accepted" : "quote_deviation_exceeds_1_pct",
      quotedOutAmount,
      deviationPct
    };
  } finally {
    clearTimeout(timeout);
  }
};
