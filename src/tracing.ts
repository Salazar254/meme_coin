import type { Logger } from "./utils/logger.ts";

export interface HotPathTrace {
  mint: string;
  eventDetectedAt: number;
  riskScoredAt?: number;
  bundleBuiltAt?: number;
  bundleSubmittedAt?: number;
  modelInferenceMs?: number;
}

export interface HotPathMetrics {
  mint: string;
  total_latency_ms: number;
  score_latency_ms: number;
  bundle_latency_ms: number;
  model_inference_ms: number;
}

export class HotPathTracer {
  logger: Logger;
  p99AlertMs: number;
  modelFallbackMs: number;
  samples: number[] = [];

  constructor(logger: Logger, p99AlertMs = 250, modelFallbackMs = 10) {
    this.logger = logger.child({ component: "tracing" });
    this.p99AlertMs = p99AlertMs;
    this.modelFallbackMs = modelFallbackMs;
  }

  complete(trace: HotPathTrace): HotPathMetrics {
    const submittedAt = trace.bundleSubmittedAt || Date.now();
    const scoreAt = trace.riskScoredAt || submittedAt;
    const builtAt = trace.bundleBuiltAt || submittedAt;
    const metrics = {
      mint: trace.mint,
      total_latency_ms: submittedAt - trace.eventDetectedAt,
      score_latency_ms: scoreAt - trace.eventDetectedAt,
      bundle_latency_ms: submittedAt - builtAt,
      model_inference_ms: trace.modelInferenceMs || 0
    };
    this.samples.push(metrics.total_latency_ms);
    if (this.samples.length > 2_000) {
      this.samples.shift();
    }
    this.logger.info(metrics, "hot_path_latency");
    if (this.p99() > this.p99AlertMs) {
      this.logger.warn({ p99TotalLatencyMs: this.p99(), thresholdMs: this.p99AlertMs }, "hot_path_p99_latency_alert");
    }
    if (metrics.model_inference_ms > this.modelFallbackMs) {
      this.logger.warn({ mint: trace.mint, modelInferenceMs: metrics.model_inference_ms }, "use_linear_fallback_model");
    }
    return metrics;
  }

  p99(): number {
    if (this.samples.length === 0) {
      return 0;
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  }
}
