import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DeployerLookup } from "../features/deployer_lookup.ts";
import { SEQUENCE_LENGTH, type ModelSequence } from "../features/sequence_buffer.ts";
import { clamp, summarizeMultiTask, type MultiTaskUncertainty } from "./uncertainty.ts";

export const ONNX_FEATURE_ORDER = [
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
  "rugcheckLpUnlocked",
  "rugcheckDangerSignals"
] as const;

export interface OnnxScoreInput {
  features: Record<string, number>;
  deployerId?: number;
  sequence?: ModelSequence;
}

export interface OnnxScoreResult {
  rugProb: number;
  timeToRug: number;
  maxDrawdown: number;
  pump2xProb: number;
  uncertainty: number;
  distributions: MultiTaskUncertainty;
  elapsedMs: number;
}

interface OnnxMetadata {
  feature_names?: string[];
}

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;

const sessionCache = new Map<string, Promise<OrtSession>>();

export class OnnxRugScorer {
  modelPath: string;
  session: OrtSession;
  ort: OrtModule;
  featureOrder: string[];
  deployerLookup?: DeployerLookup;
  mcPasses: number;

  private constructor(
    modelPath: string,
    session: OrtSession,
    ort: OrtModule,
    featureOrder: string[],
    mcPasses: number,
    deployerLookup?: DeployerLookup
  ) {
    this.modelPath = modelPath;
    this.session = session;
    this.ort = ort;
    this.featureOrder = featureOrder;
    this.mcPasses = mcPasses;
    this.deployerLookup = deployerLookup;
  }

  static async load(modelPath: string, options: {
    metadataPath?: string;
    mcPasses?: number;
    deployerLookup?: DeployerLookup;
  } = {}): Promise<OnnxRugScorer> {
    const ort = await import("onnxruntime-node");
    const resolved = resolve(modelPath);
    let sessionPromise = sessionCache.get(resolved);
    if (!sessionPromise) {
      sessionPromise = ort.InferenceSession.create(resolved, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        intraOpNumThreads: 1,
        interOpNumThreads: 1
      });
      sessionCache.set(resolved, sessionPromise);
    }
    const session = await sessionPromise;
    const metadataPath = options.metadataPath || resolved.replace(/\.onnx$/i, "_meta.json");
    const featureOrder = await loadFeatureOrder(metadataPath);
    return new OnnxRugScorer(resolved, session, ort, featureOrder, options.mcPasses ?? 20, options.deployerLookup);
  }

  async score(input: OnnxScoreInput, passes = this.mcPasses): Promise<OnnxScoreResult> {
    const started = performance.now();
    const samples: Array<{ rugProb: number; timeToRug: number; maxDrawdown: number; pump2xProb: number }> = [];
    const runCount = Math.max(1, passes);
    for (let index = 0; index < runCount; index += 1) {
      const outputs = await this.session.run(this.feeds(input));
      samples.push({
        rugProb: clamp(readScalar(outputs.rug_prob)),
        timeToRug: Math.max(0, readScalar(outputs.time_to_rug_hours)),
        maxDrawdown: clamp(readScalar(outputs.max_drawdown_pct), 0, 100),
        pump2xProb: clamp(readScalar(outputs.pump_2x_prob))
      });
    }
    const distributions = summarizeMultiTask(samples);
    return {
      rugProb: distributions.rugProb.mean,
      timeToRug: distributions.timeToRug.mean,
      maxDrawdown: distributions.maxDrawdown.mean,
      pump2xProb: distributions.pump2xProb.mean,
      uncertainty: distributions.rugProb.std,
      distributions,
      elapsedMs: performance.now() - started
    };
  }

  async scoreFast(input: OnnxScoreInput): Promise<OnnxScoreResult> {
    return this.score(input, 1);
  }

  feeds(input: OnnxScoreInput): Record<string, import("onnxruntime-node").Tensor> {
    const featureValues = this.featureOrder.map((name) => Number.isFinite(input.features[name]) ? input.features[name] : 0);
    const sequence = normalizeSequence(input.sequence);
    const deployerId = BigInt(Math.max(0, input.deployerId ?? 0));
    return {
      tabular: new this.ort.Tensor("float32", Float32Array.from(featureValues), [1, this.featureOrder.length]),
      deployer_id: new this.ort.Tensor("int64", BigInt64Array.from([deployerId]), [1]),
      sequence: new this.ort.Tensor("float32", Float32Array.from(sequence.flat()), [1, SEQUENCE_LENGTH, 5])
    };
  }
}

const normalizeSequence = (sequence?: ModelSequence): ModelSequence => {
  const empty = [0, 0, 0, 1, 0];
  const rows = (sequence || []).slice(-SEQUENCE_LENGTH).map((row) => [
    finite(row[0], 0),
    finite(row[1], 0),
    finite(row[2], 0),
    finite(row[3], 1),
    finite(row[4], 0)
  ]);
  while (rows.length < SEQUENCE_LENGTH) {
    rows.unshift([...empty]);
  }
  return rows;
};

const finite = (value: number | undefined, fallback: number): number => Number.isFinite(value) ? Number(value) : fallback;

const readScalar = (tensor: import("onnxruntime-node").Tensor | undefined): number => {
  if (!tensor) {
    return 0;
  }
  const data = tensor.data as Float32Array | number[];
  return Number(data[0] ?? 0);
};

const loadFeatureOrder = async (metadataPath: string): Promise<string[]> => {
  try {
    const raw = await readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as OnnxMetadata;
    if (Array.isArray(parsed.feature_names) && parsed.feature_names.length > 0) {
      return parsed.feature_names;
    }
  } catch {
    return [...ONNX_FEATURE_ORDER];
  }
  return [...ONNX_FEATURE_ORDER];
};
