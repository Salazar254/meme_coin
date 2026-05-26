import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createLogger } from "../src/utils/logger.ts";

interface TrainExample {
  source: string;
  year: number;
  label: number;
  weight: number;
  features: Record<string, number>;
}

interface Metrics {
  count: number;
  positiveRate: number;
  logLoss: number;
  accuracy: number;
  auc: number;
}

interface DatasetStats {
  count: number;
  positive: number;
}

const FEATURE_ORDER = [
  "rugPullRisk",
  "honeypotRisk",
  "lpBurnGap",
  "transferTaxPct",
  "topHolderPct",
  "devHoldPct",
  "mutableMetadata",
  "mintAuthority",
  "freezeAuthority",
  "volatility1m",
  "lowLiquidity",
  "lowBuyers",
  "rugcheckScore",
  "rugcheckTopHolders"
];

const SOLRPDS_FILES = [
  "https://huggingface.co/datasets/DeFiLab/SolRPDS/resolve/main/dataset/CSV/2021.csv",
  "https://huggingface.co/datasets/DeFiLab/SolRPDS/resolve/main/dataset/CSV/2022.csv",
  "https://huggingface.co/datasets/DeFiLab/SolRPDS/resolve/main/dataset/CSV/2023.csv",
  "https://huggingface.co/datasets/DeFiLab/SolRPDS/resolve/main/dataset/CSV/Jan_2024-Nov_2024.csv"
];

const PUMP_STUDIO_FILES = [
  "https://huggingface.co/datasets/Pumpdotstudio/pump-fun-sentiment-100k/resolve/main/data/train-2026-03-04T16-18-11.jsonl",
  "https://huggingface.co/datasets/Pumpdotstudio/pump-fun-sentiment-100k/resolve/main/data/train-2026-03-04T16-18-36.jsonl",
  "https://huggingface.co/datasets/Pumpdotstudio/pump-fun-sentiment-100k/resolve/main/data/train-2026-03-04T16-19-16.jsonl",
  "https://huggingface.co/datasets/Pumpdotstudio/pump-fun-sentiment-100k/resolve/main/data/train-2026-03-04T16-20-12.jsonl"
];

const logger = createLogger("info", { service: "rug_model_trainer" });
const clamp = (value: number, low = 0, high = 1): number => Math.max(low, Math.min(high, value));
const sigmoid = (value: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir || "data/training";
  const output = args.output || "models/rug_model.json";
  const epochs = Number.parseInt(args.epochs || "900", 10);
  const lr = Number.parseFloat(args.lr || "0.11");
  const l2 = Number.parseFloat(args.l2 || "0.012");
  const blockThreshold = Number.parseFloat(args.blockThreshold || "0.15");
  const pumpShards = Number.parseInt(args.pumpShards || "1", 10);

  if (args.download !== "false") {
    await downloadDatasets(dataDir, pumpShards);
  }

  const examples = await loadExamples(dataDir);
  if (examples.length < 1000) {
    throw new Error(`not_enough_training_examples:${examples.length}`);
  }

  const filtered = examples.filter((item) => item.year >= 2021 && item.year <= 2026);
  const split = splitExamples(filtered);
  const rawModel = trainLogistic(split.train, epochs, lr, l2);
  const model = calibrateForRuntimeThreshold(rawModel, blockThreshold);
  const trainMetrics = evaluate(split.train, model, blockThreshold);
  const valMetrics = evaluate(split.validation, model, blockThreshold);
  const testMetrics = evaluate(split.test, model, blockThreshold);
  const byYear = summarizeBy(filtered, (item) => String(item.year));
  const bySource = summarizeBy(filtered, (item) => item.source);

  await mkdir("models", { recursive: true });
  await writeFile(output, `${JSON.stringify({
    version: 5,
    trainedAt: new Date().toISOString(),
    objective: "weighted_logistic_rug_risk",
    featureOrder: FEATURE_ORDER,
    bias: model.bias,
    weights: model.weights,
    training: {
      requestedRange: "2021-2026",
      runtimeBlockThreshold: blockThreshold,
      calibration: "shifted_logit_boundary_from_0.50_to_runtime_block_threshold",
      actualCoverageByYear: byYear,
      actualCoverageBySource: bySource,
      samples: filtered.length,
      train: trainMetrics,
      validation: valMetrics,
      test: testMetrics,
      sources: [
        "DeFiLab/SolRPDS 2021-2024 liquidity/rug-pull dataset",
        "Pumpdotstudio/pump-fun-sentiment-100k 2026 Pump.fun risk snapshots"
      ],
      notes: [
        "No labeled 2025 corpus was present locally or downloaded by this trainer.",
        "2026 labels are risk-assessment labels, not realized PnL labels.",
        "SolRPDS labels are liquidity/rug behavior labels, mapped into runtime scorer features."
      ]
    }
  }, null, 2)}\n`, "utf8");

  logger.info({
    output,
    samples: filtered.length,
    train: trainMetrics,
    validation: valMetrics,
    test: testMetrics,
    coverage: byYear
  }, "rug_model_fine_tuned");
};

const downloadDatasets = async (dataDir: string, pumpShards: number): Promise<void> => {
  await mkdir(join(dataDir, "solrpds"), { recursive: true });
  await mkdir(join(dataDir, "pumpstudio"), { recursive: true });
  for (const url of SOLRPDS_FILES) {
    await downloadIfMissing(url, join(dataDir, "solrpds", decodeURIComponent(basename(url))));
  }
  for (const url of PUMP_STUDIO_FILES.slice(0, Math.max(1, Math.min(PUMP_STUDIO_FILES.length, pumpShards)))) {
    await downloadIfMissing(url, join(dataDir, "pumpstudio", decodeURIComponent(basename(url))));
  }
};

const downloadIfMissing = async (url: string, path: string): Promise<void> => {
  try {
    const info = await stat(path);
    if (info.size > 0) {
      logger.info({ path, bytes: info.size }, "dataset_cache_hit");
      return;
    }
  } catch {
    await mkdir(dirname(path), { recursive: true });
  }

  logger.info({ url, path }, "dataset_download_start");
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download_failed:${response.status}:${url}`);
  }
  await pipeline(Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>), createWriteStream(path));
  const info = await stat(path);
  logger.info({ path, bytes: info.size }, "dataset_downloaded");
};

const loadExamples = async (dataDir: string): Promise<TrainExample[]> => {
  const examples: TrainExample[] = [];
  const solrpdsDir = join(dataDir, "solrpds");
  const pumpDir = join(dataDir, "pumpstudio");

  for (const file of await safeReaddir(solrpdsDir)) {
    if (file.toLowerCase().endsWith(".csv")) {
      examples.push(...await loadSolrpdsCsv(join(solrpdsDir, file)));
    }
  }

  for (const file of await safeReaddir(pumpDir)) {
    if (file.toLowerCase().endsWith(".jsonl")) {
      examples.push(...await loadPumpStudioJsonl(join(pumpDir, file)));
    }
  }

  return examples;
};

const loadSolrpdsCsv = async (path: string): Promise<TrainExample[]> => {
  const raw = await readFile(path, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return [];
  }
  const headers = parseCsvLine(lines[0]);
  const examples: TrainExample[] = [];
  for (const line of lines.slice(1)) {
    const row = Object.fromEntries(parseCsvLine(line).map((value, index) => [headers[index], value]));
    const first = parseDate(row.FIRST_POOL_ACTIVITY_TIMESTAMP || row.first_pool_activity_timestamp);
    const last = parseDate(row.LAST_POOL_ACTIVITY_TIMESTAMP || row.last_pool_activity_timestamp);
    const year = first.getUTCFullYear();
    const added = safeNumber(row.TOTAL_ADDED_LIQUIDITY);
    const removed = safeNumber(row.TOTAL_REMOVED_LIQUIDITY);
    const addCount = safeNumber(row.NUM_LIQUIDITY_ADDS);
    const removeCount = safeNumber(row.NUM_LIQUIDITY_REMOVES);
    const status = String(row.INACTIVITY_STATUS || "").toLowerCase();
    const removedShare = removed / Math.max(added + removed, 1e-9);
    const removeToAdd = removed / Math.max(added, 1e-9);
    const activityHours = Math.max(0, (last.getTime() - first.getTime()) / 3_600_000);
    const inactive = status !== "active";
    const label = inactive ? 1 : removedShare > 0.74 || removeToAdd > 1.15 ? 0.82 : 0.08;
    const lowLiquidity = clamp(1 / Math.log10(Math.max(added, 10)));
    const removePressure = clamp(removeToAdd / 2);
    const removeFrequency = clamp(removeCount / Math.max(addCount + removeCount, 1));

    if (!Number.isFinite(year) || year < 2021 || year > 2026) {
      continue;
    }
    examples.push({
      source: "solrpds",
      year,
      label,
      weight: inactive ? 1.2 : 0.8,
      features: {
        rugPullRisk: clamp(0.18 + removePressure * 0.78),
        honeypotRisk: clamp(inactive ? 0.22 : 0.04 + removeFrequency * 0.18),
        lpBurnGap: clamp(removedShare),
        transferTaxPct: 0,
        topHolderPct: clamp(0.08 + removeFrequency * 0.22),
        devHoldPct: clamp(removePressure * 0.32),
        mutableMetadata: 0,
        mintAuthority: 0.15,
        freezeAuthority: 0.15,
        volatility1m: clamp(removeFrequency + (activityHours < 1 ? 0.25 : 0)),
        lowLiquidity,
        lowBuyers: clamp(1 - addCount / 24),
        rugcheckScore: clamp(label),
        rugcheckTopHolders: clamp(0.08 + removePressure * 0.35)
      }
    });
  }
  logger.info({ path, rows: examples.length }, "solrpds_loaded");
  return examples;
};

const loadPumpStudioJsonl = async (path: string): Promise<TrainExample[]> => {
  const raw = await readFile(path, "utf8");
  const examples: TrainExample[] = [];
  let skippedInvalidJson = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      skippedInvalidJson += 1;
      continue;
    }
    if (row.validated === false) {
      continue;
    }
    const timestamp = safeNumber(row.timestamp || row.snapshot_at);
    const date = new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000);
    const year = date.getUTCFullYear();
    const risk = parseRiskLevel(row.risk_level);
    if (risk === undefined || year < 2021 || year > 2026) {
      continue;
    }
    const factors = String(row.risk_factors || "").toLowerCase();
    const top10 = clamp(safeNumber(row.top10_holder_pct) / 100);
    const holders = safeNumber(row.holder_count);
    const liquidity = safeNumber(row.liquidity || row.dev_liquidity);
    const marketCap = safeNumber(row.market_cap || row.dev_market_cap);
    const buys = safeNumber(row.buys_24h);
    const sells = safeNumber(row.sells_24h);
    const buyPressure = safeNumber(row.buy_pressure) / 100;
    const volatility = safeNumber(row.volatility_score) / 100;
    const concentration = classOrdinal(row.holder_concentration, ["distributed", "moderate", "concentrated", "whale_dominated"]);
    const liquidityDepth = classOrdinal(row.liquidity_depth, ["deep", "moderate", "shallow", "dry"]);
    const volumeProfile = classOrdinal(row.volume_profile, ["surging", "rising", "stable", "declining", "dead"]);
    const sellPressure = sells / Math.max(buys + sells, 1);
    const liquidityToMcap = liquidity / Math.max(marketCap, 1);

    examples.push({
      source: "pumpstudio",
      year,
      label: risk.label,
      weight: risk.weight,
      features: {
        rugPullRisk: clamp(risk.label * 0.45 + concentration * 0.28 + (factors.includes("rapid_sell_off") ? 0.18 : 0) + (factors.includes("wash") ? 0.12 : 0)),
        honeypotRisk: clamp((factors.includes("single_holder") ? 0.22 : 0) + (factors.includes("dead_volume") ? 0.18 : 0) + sellPressure * 0.2),
        lpBurnGap: clamp((factors.includes("no_liquidity_lock") ? 0.72 : 0.08) + liquidityDepth * 0.22),
        transferTaxPct: 0,
        topHolderPct: top10,
        devHoldPct: clamp(top10 * 0.5 + (factors.includes("new_deployer") ? 0.08 : 0)),
        mutableMetadata: factors.includes("no_website") || factors.includes("no_social_presence") ? 0.18 : 0,
        mintAuthority: factors.includes("new_deployer") ? 0.28 : 0.08,
        freezeAuthority: 0.08,
        volatility1m: clamp(volatility + volumeProfile * 0.18),
        lowLiquidity: clamp(1 - liquidityToMcap * 2 + liquidityDepth * 0.35),
        lowBuyers: clamp(1 - holders / 750),
        rugcheckScore: clamp(risk.label),
        rugcheckTopHolders: top10
      }
    });
  }
  logger.info({ path, rows: examples.length, skippedInvalidJson }, "pumpstudio_loaded");
  return examples;
};

const trainLogistic = (examples: TrainExample[], epochs: number, lr: number, l2: number): { bias: number; weights: Record<string, number> } => {
  const weights = Object.fromEntries(FEATURE_ORDER.map((key) => [key, 0])) as Record<string, number>;
  let bias = 0;
  const n = Math.max(examples.reduce((sum, item) => sum + item.weight, 0), 1);

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const grad = Object.fromEntries(FEATURE_ORDER.map((key) => [key, 0])) as Record<string, number>;
    let biasGrad = 0;
    for (const example of examples) {
      const z = bias + FEATURE_ORDER.reduce((sum, key) => sum + weights[key] * example.features[key], 0);
      const pred = sigmoid(z);
      const error = (pred - example.label) * example.weight;
      biasGrad += error;
      for (const key of FEATURE_ORDER) {
        grad[key] += error * example.features[key];
      }
    }
    bias -= lr * biasGrad / n;
    for (const key of FEATURE_ORDER) {
      const update = grad[key] / n + l2 * weights[key];
      weights[key] -= lr * update;
    }
    if (epoch > 0 && epoch % 250 === 0) {
      logger.info({ epoch, metrics: evaluate(examples.slice(0, Math.min(examples.length, 15000)), { bias, weights }) }, "training_progress");
    }
  }

  return { bias, weights };
};

const evaluate = (examples: TrainExample[], model: { bias: number; weights: Record<string, number> }, threshold = 0.5): Metrics => {
  if (examples.length === 0) {
    return { count: 0, positiveRate: 0, logLoss: 0, accuracy: 0, auc: 0 };
  }
  const pairs = examples.map((example) => {
    const score = sigmoid(model.bias + FEATURE_ORDER.reduce((sum, key) => sum + model.weights[key] * example.features[key], 0));
    return { score, label: example.label >= 0.5 ? 1 : 0 };
  });
  const logLoss = pairs.reduce((sum, item) => {
    const p = clamp(item.score, 1e-6, 1 - 1e-6);
    return sum - (item.label * Math.log(p) + (1 - item.label) * Math.log(1 - p));
  }, 0) / pairs.length;
  const accuracy = pairs.filter((item) => (item.score >= threshold ? 1 : 0) === item.label).length / pairs.length;
  const positiveRate = pairs.filter((item) => item.label === 1).length / pairs.length;
  return {
    count: examples.length,
    positiveRate,
    logLoss,
    accuracy,
    auc: auc(pairs)
  };
};

const calibrateForRuntimeThreshold = (
  model: { bias: number; weights: Record<string, number> },
  blockThreshold: number
): { bias: number; weights: Record<string, number> } => {
  const threshold = clamp(blockThreshold, 0.01, 0.49);
  return {
    bias: model.bias + Math.log(threshold / (1 - threshold)),
    weights: model.weights
  };
};

const auc = (pairs: Array<{ score: number; label: number }>): number => {
  const sorted = [...pairs].sort((a, b) => a.score - b.score);
  let rankSum = 0;
  let positives = 0;
  let negatives = 0;
  sorted.forEach((item, index) => {
    if (item.label === 1) {
      rankSum += index + 1;
      positives += 1;
    } else {
      negatives += 1;
    }
  });
  if (positives === 0 || negatives === 0) {
    return 0.5;
  }
  return (rankSum - positives * (positives + 1) / 2) / (positives * negatives);
};

const splitExamples = (examples: TrainExample[]): { train: TrainExample[]; validation: TrainExample[]; test: TrainExample[] } => {
  const sorted = [...examples].sort((a, b) => a.year - b.year);
  const test = sorted.filter((item) => item.year >= 2026);
  const pre2026 = sorted.filter((item) => item.year < 2026);
  const validation = pre2026.filter((item) => item.year >= 2024);
  const train = pre2026.filter((item) => item.year < 2024);
  if (test.length > 0 && validation.length > 0 && train.length > 0) {
    return { train, validation, test };
  }
  const first = Math.floor(sorted.length * 0.7);
  const second = Math.floor(sorted.length * 0.85);
  return {
    train: sorted.slice(0, first),
    validation: sorted.slice(first, second),
    test: sorted.slice(second)
  };
};

const summarizeBy = (examples: TrainExample[], keyFn: (item: TrainExample) => string): Record<string, DatasetStats> => {
  const output: Record<string, DatasetStats> = {};
  for (const example of examples) {
    const key = keyFn(example);
    output[key] ||= { count: 0, positive: 0 };
    output[key].count += 1;
    output[key].positive += example.label >= 0.5 ? 1 : 0;
  }
  return output;
};

const parseCsvLine = (line: string): string[] => {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values.map((value) => value.trim());
};

const safeReaddir = async (path: string): Promise<string[]> => {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
};

const safeNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value !== "string") {
    return 0;
  }
  const parsed = Number.parseFloat(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseDate = (value: unknown): Date => {
  if (typeof value === "number") {
    return new Date(value > 10_000_000_000 ? value : value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    return new Date(value.replace(" ", "T").replace(".000", "Z"));
  }
  return new Date(0);
};

const parseRiskLevel = (value: unknown): { label: number; weight: number } | undefined => {
  const text = String(value || "").toLowerCase();
  if (text.includes("critical")) {
    return { label: 1, weight: 1.25 };
  }
  if (text.includes("high")) {
    return { label: 0.86, weight: 1.1 };
  }
  if (text.includes("medium")) {
    return { label: 0.48, weight: 0.65 };
  }
  if (text.includes("low")) {
    return { label: 0.08, weight: 1 };
  }
  return undefined;
};

const classOrdinal = (value: unknown, ordered: string[]): number => {
  const text = String(value || "").toLowerCase();
  const index = ordered.findIndex((item) => text.includes(item));
  if (index < 0) {
    return 0;
  }
  return ordered.length <= 1 ? 0 : index / (ordered.length - 1);
};

const parseArgs = (args: string[]): Record<string, string> => {
  const output: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    output[key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = inlineValue || args[index + 1] || "true";
    if (!inlineValue && args[index + 1] && !args[index + 1].startsWith("--")) {
      index += 1;
    }
  }
  return output;
};

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";

if (import.meta.url === entryUrl) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "training_failed");
    process.exitCode = 1;
  });
}
