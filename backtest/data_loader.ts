import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { TokenLaunchEvent } from "../src/token_risk_scorer.ts";

export type HistoricalLaunchEvent = Omit<TokenLaunchEvent, "futureReturnPct"> & {
  launchPlatform?: "pump.fun" | "raydium" | "moonshot" | "unknown" | string;
  entryPriceSol?: number;
  baseReserveSol?: number;
  quoteReserveTokens?: number;
};

export interface OhlcvBar {
  mint: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeSol: number;
  baseReserveSol?: number;
  quoteReserveTokens?: number;
}

export interface JitoTipBar {
  timestamp: number;
  p50TipSol: number;
  p75TipSol: number;
  p95TipSol: number;
}

export interface HistoricalDataset {
  events: HistoricalLaunchEvent[];
  ohlcv: OhlcvBar[];
  jitoTips: JitoTipBar[];
}

const leakedFields = new Set([
  "futureReturnPct",
  "future_return_pct",
  "futureReturn",
  "realizedPnl",
  "realizedPnL",
  "labelReturn"
]);

export const assertNoFutureLeakage = (payload: Record<string, unknown>, source = "event"): void => {
  const present = Object.keys(payload).filter((key) => leakedFields.has(key));
  if (present.length > 0) {
    throw new Error(`future_leakage_detected:${source}:${present.join(",")}`);
  }
};

export const loadHistoricalDataset = async (paths: {
  eventsPath: string;
  ohlcvPath: string;
  jitoTipsPath?: string;
}): Promise<HistoricalDataset> => {
  const events = (await loadRecords(paths.eventsPath)).map((row, index) => {
    assertNoFutureLeakage(row, `${paths.eventsPath}#${index + 1}`);
    return normalizeEvent(row);
  }).sort((a, b) => a.timestamp - b.timestamp);
  const ohlcv = (await loadRecords(paths.ohlcvPath)).map(normalizeOhlcv).sort((a, b) => a.timestamp - b.timestamp);
  const jitoTips = paths.jitoTipsPath
    ? (await loadRecords(paths.jitoTipsPath)).map(normalizeTip).sort((a, b) => a.timestamp - b.timestamp)
    : [];
  return { events, ohlcv, jitoTips };
};

export const loadRecords = async (path: string): Promise<Record<string, unknown>[]> => {
  const resolved = resolve(path);
  const extension = extname(resolved).toLowerCase();
  if (extension === ".jsonl" || extension === ".ndjson") {
    return loadJsonl(resolved);
  }
  if (extension === ".json") {
    const parsed = JSON.parse(await readFile(resolved, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [parsed as Record<string, unknown>];
  }
  if (extension === ".parquet") {
    throw new Error("parquet_loader_requires_pyarrow_jsonl_export");
  }
  throw new Error(`unsupported_backtest_file:${extension}`);
};

const loadJsonl = async (path: string): Promise<Record<string, unknown>[]> => {
  const rows: Record<string, unknown>[] = [];
  const reader = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line of reader) {
    if (line.trim()) {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return rows;
};

const normalizeEvent = (row: Record<string, unknown>): HistoricalLaunchEvent => ({
  mint: String(row.mint),
  deployer: String(row.deployer || row.creator || "unknown"),
  timestamp: asTimestamp(row.timestamp),
  liquiditySol: asNumber(row.liquiditySol ?? row.liquidity_sol),
  lpBurnPct: asNumber(row.lpBurnPct ?? row.lp_burn_pct, 1),
  ageSeconds: asNumber(row.ageSeconds ?? row.age_seconds),
  uniqueBuyers: asNumber(row.uniqueBuyers ?? row.unique_buyers),
  totalVolumeSol: asNumber(row.totalVolumeSol ?? row.total_volume_sol),
  marketCapSol: asNumber(row.marketCapSol ?? row.market_cap_sol),
  rugPullRisk: asNumber(row.rugPullRisk ?? row.rug_pull_risk),
  honeypotRisk: asNumber(row.honeypotRisk ?? row.honeypot_risk),
  transferTaxPct: asNumber(row.transferTaxPct ?? row.transfer_tax_pct),
  topHolderPct: asNumber(row.topHolderPct ?? row.top_holder_pct),
  devHoldPct: asNumber(row.devHoldPct ?? row.dev_hold_pct),
  mutableMetadata: Boolean(row.mutableMetadata ?? row.mutable_metadata),
  mintAuthorityRenounced: Boolean(row.mintAuthorityRenounced ?? row.mint_authority_renounced),
  freezeAuthorityRenounced: Boolean(row.freezeAuthorityRenounced ?? row.freeze_authority_renounced),
  volatility1m: asNumber(row.volatility1m ?? row.volatility_1m),
  priceVelocity1m: asNumber(row.priceVelocity1m ?? row.price_velocity_1m),
  buySellRatio: asNumber(row.buySellRatio ?? row.buy_sell_ratio, 1),
  jitoCompetition: asNumber(row.jitoCompetition ?? row.jito_competition),
  launchRatePerMinute: asNumber(row.launchRatePerMinute ?? row.launch_rate_per_minute),
  predictedWinProb: asNumber(row.predictedWinProb ?? row.predicted_win_prob, 0.5),
  rewardRiskRatio: asNumber(row.rewardRiskRatio ?? row.reward_risk_ratio, 1),
  synthetic: Boolean(row.synthetic),
  launchPlatform: String(row.launchPlatform ?? row.launch_platform ?? "unknown"),
  entryPriceSol: optionalNumber(row.entryPriceSol ?? row.entry_price_sol),
  baseReserveSol: optionalNumber(row.baseReserveSol ?? row.base_reserve_sol),
  quoteReserveTokens: optionalNumber(row.quoteReserveTokens ?? row.quote_reserve_tokens)
});

const normalizeOhlcv = (row: Record<string, unknown>): OhlcvBar => ({
  mint: String(row.mint),
  timestamp: asTimestamp(row.timestamp),
  open: asNumber(row.open),
  high: asNumber(row.high),
  low: asNumber(row.low),
  close: asNumber(row.close),
  volumeSol: asNumber(row.volumeSol ?? row.volume_sol),
  baseReserveSol: optionalNumber(row.baseReserveSol ?? row.base_reserve_sol),
  quoteReserveTokens: optionalNumber(row.quoteReserveTokens ?? row.quote_reserve_tokens)
});

const normalizeTip = (row: Record<string, unknown>): JitoTipBar => ({
  timestamp: asTimestamp(row.timestamp),
  p50TipSol: asNumber(row.p50TipSol ?? row.p50_tip_sol, 0.0001),
  p75TipSol: asNumber(row.p75TipSol ?? row.p75_tip_sol, 0.00025),
  p95TipSol: asNumber(row.p95TipSol ?? row.p95_tip_sol, 0.0006)
});

const asTimestamp = (value: unknown): number => {
  if (typeof value === "number") {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const asNumber = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const optionalNumber = (value: unknown): number | undefined => {
  const parsed = asNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
};
