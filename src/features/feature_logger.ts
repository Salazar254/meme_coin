import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../utils/logger.ts";
import type { TokenLaunchEvent, RugCheckSummary } from "../token_risk_scorer.ts";
import { computeTabularFeatures } from "./feature_schema.ts";

export interface FeatureLogRecord {
  ts: string;
  mint: string;
  raw: TokenLaunchEvent;
  rugcheck?: RugCheckSummary;
  features: Record<string, number>;
}

export class FeatureLogger {
  path: string;
  logger: Logger;

  constructor(path = "data/feature_logs.jsonl", logger: Logger) {
    this.path = path;
    this.logger = logger.child({ component: "feature_logger" });
  }

  async log(event: TokenLaunchEvent, rugcheck?: RugCheckSummary): Promise<Record<string, number>> {
    const features = computeTabularFeatures({ event, rugcheck });
    const record: FeatureLogRecord = {
      ts: new Date().toISOString(),
      mint: event.mint,
      raw: event,
      rugcheck,
      features
    };
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ mint: event.mint, error: message }, "feature_log_failed");
    }
    return features;
  }
}

export interface DriftAlert {
  feature: string;
  ksStatistic: number;
  alert: boolean;
}

export const ksStatistic = (reference: number[], current: number[]): number => {
  const left = [...reference].sort((a, b) => a - b);
  const right = [...current].sort((a, b) => a - b);
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const values = [...left, ...right].sort((a, b) => a - b);
  let maxDelta = 0;
  for (const value of values) {
    const leftCdf = upperBound(left, value) / left.length;
    const rightCdf = upperBound(right, value) / right.length;
    maxDelta = Math.max(maxDelta, Math.abs(leftCdf - rightCdf));
  }
  return maxDelta;
};

export const compareFeatureDistributions = (
  referenceRows: Array<Record<string, number>>,
  currentRows: Array<Record<string, number>>,
  threshold = 0.18
): DriftAlert[] => {
  const names = new Set([...referenceRows.flatMap(Object.keys), ...currentRows.flatMap(Object.keys)]);
  return [...names].sort().map((feature) => {
    const stat = ksStatistic(
      referenceRows.map((row) => Number(row[feature] || 0)),
      currentRows.map((row) => Number(row[feature] || 0))
    );
    return { feature, ksStatistic: stat, alert: stat >= threshold };
  });
};

export const readFeatureLog = async (path: string): Promise<Array<Record<string, number>>> => {
  const raw = await readFile(path, "utf8");
  return raw.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FeatureLogRecord)
    .map((record) => record.features);
};

const upperBound = (values: number[], target: number): number => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] <= target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
};
