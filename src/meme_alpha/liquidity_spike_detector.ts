import type { MemeAlphaConfig } from "../config.ts";
import type { TokenLaunchEvent } from "../token_risk_scorer.ts";

export interface LiquiditySpikeSignal {
  accepted: boolean;
  score: number;
  spikePct: number;
  liquidityDeltaSol: number;
  volumeSpikeRatio: number;
  volumeBottleneckRatio: number;
  reasons: string[];
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export class LiquiditySpikeDetector {
  config: MemeAlphaConfig;

  constructor(config: MemeAlphaConfig) {
    this.config = config;
  }

  detect(event: TokenLaunchEvent): LiquiditySpikeSignal {
    const previousLiquidity = Math.max(event.previousLiquiditySol ?? inferPreviousLiquidity(event), 1e-9);
    const liquidityDeltaSol = Math.max(0, event.liquiditySol - previousLiquidity);
    const spikePct = event.liquiditySpikePct ?? liquidityDeltaSol / previousLiquidity;
    const previousVolume = Math.max(event.previousVolumeSol ?? event.totalVolumeSol / 2, 1e-9);
    const volumeSpikeRatio = event.volumeSpikeRatio ?? event.totalVolumeSol / previousVolume;
    const volumeBottleneckRatio = volumeBottleneck(event, liquidityDeltaSol, volumeSpikeRatio);
    const reasons: string[] = [];
    if (spikePct < this.config.liquiditySpikePct) {
      reasons.push("liquidity_spike_below_threshold");
    }
    if (liquidityDeltaSol < this.config.minLiquidityDeltaSol) {
      reasons.push("liquidity_delta_below_threshold");
    }
    if (volumeSpikeRatio < this.config.volumeSpikeRatio) {
      reasons.push("volume_spike_below_threshold");
    }
    const score = clamp01(
      spikePct / Math.max(this.config.liquiditySpikePct * 2.5, 1e-9) * 0.38
      + liquidityDeltaSol / Math.max(this.config.minLiquidityDeltaSol * 4, 1e-9) * 0.28
      + volumeSpikeRatio / Math.max(this.config.volumeSpikeRatio * 3, 1e-9) * 0.2
      + volumeBottleneckRatio * 0.14
    );
    return {
      accepted: reasons.length === 0,
      score,
      spikePct,
      liquidityDeltaSol,
      volumeSpikeRatio,
      volumeBottleneckRatio,
      reasons
    };
  }
}

const inferPreviousLiquidity = (event: TokenLaunchEvent): number => {
  if (event.liquiditySpikePct && event.liquiditySpikePct > 0) {
    return event.liquiditySol / (1 + event.liquiditySpikePct);
  }
  return event.ageSeconds <= 10 ? event.liquiditySol * 0.55 : event.liquiditySol * 0.75;
};

const volumeBottleneck = (event: TokenLaunchEvent, liquidityDeltaSol: number, volumeSpikeRatio: number): number => {
  const depth = Math.max(event.liquiditySol, 1e-9);
  const volumePressure = event.totalVolumeSol / depth;
  const freshLiquidityPressure = liquidityDeltaSol / depth;
  const buyerPressure = Math.max(0, event.buySellRatio - 1) / 2;
  return clamp01(volumePressure * 0.24 + freshLiquidityPressure * 0.36 + volumeSpikeRatio * 0.08 + buyerPressure * 0.32);
};
