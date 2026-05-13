import type { MarketRegime } from "./config.ts";
import type { RpcPool } from "./utils/rpc_pool.ts";

export interface MevGuardRequest {
  quotedOutAmount: bigint;
  transactionBase64: string;
  regime: MarketRegime;
  rpc: RpcPool;
}

export interface MevGuardResult {
  accepted: boolean;
  reason: string;
  dynamicSlippagePct: number;
  simulatedOutAmount?: bigint;
}

const slippageByRegime: Record<MarketRegime, number> = {
  stress: 0.5,
  caution: 1.0,
  normal: 1.5,
  burst: 2.0
};

export const dynamicSlippagePct = (regime: MarketRegime): number => slippageByRegime[regime];

export const checkMevProtection = async (request: MevGuardRequest): Promise<MevGuardResult> => {
  const dynamicSlippage = dynamicSlippagePct(request.regime);
  const simulation = await request.rpc.call<{ value?: { err?: unknown; logs?: string[]; returnData?: { data?: [string, string] } } }>("simulateTransaction", [
    request.transactionBase64,
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }
  ]);
  if (simulation.value?.err) {
    return { accepted: false, reason: "simulation_failed", dynamicSlippagePct: dynamicSlippage };
  }
  const simulatedOutAmount = parseSimulatedOutAmount(simulation.value?.logs || []);
  if (simulatedOutAmount !== undefined && simulatedOutAmount < request.quotedOutAmount * 99n / 100n) {
    return {
      accepted: false,
      reason: "frontrun_or_sandwich_detected",
      dynamicSlippagePct: dynamicSlippage,
      simulatedOutAmount
    };
  }
  return {
    accepted: true,
    reason: "bundle_only_execution_required",
    dynamicSlippagePct: dynamicSlippage,
    simulatedOutAmount
  };
};

const parseSimulatedOutAmount = (logs: string[]): bigint | undefined => {
  for (const log of logs) {
    const match = /out(?:put)?[_ ]amount[:=](\d+)/i.exec(log);
    if (match) {
      return BigInt(match[1]);
    }
  }
  return undefined;
};
