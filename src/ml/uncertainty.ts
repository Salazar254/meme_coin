export interface DistributionSummary {
  mean: number;
  std: number;
  min: number;
  max: number;
  samples: number;
}

export interface MultiTaskUncertainty {
  rugProb: DistributionSummary;
  timeToRug: DistributionSummary;
  maxDrawdown: DistributionSummary;
  pump2xProb: DistributionSummary;
}

export const clamp = (value: number, low = 0, high = 1): number => Math.max(low, Math.min(high, value));

export const summarize = (values: number[]): DistributionSummary => {
  if (values.length === 0) {
    return { mean: 0, std: 0, min: 0, max: 0, samples: 0 };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    mean,
    std: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
    samples: values.length
  };
};

export const summarizeMultiTask = (samples: Array<{
  rugProb: number;
  timeToRug: number;
  maxDrawdown: number;
  pump2xProb: number;
}>): MultiTaskUncertainty => ({
  rugProb: summarize(samples.map((item) => item.rugProb)),
  timeToRug: summarize(samples.map((item) => item.timeToRug)),
  maxDrawdown: summarize(samples.map((item) => item.maxDrawdown)),
  pump2xProb: summarize(samples.map((item) => item.pump2xProb))
});

export const shouldBlockRugRisk = (mean: number, std: number): boolean => mean > 0.15 && std < 0.05;

export const shouldReviewUncertainty = (std: number): boolean => std > 0.10;
