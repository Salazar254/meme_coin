import type { TokenLaunchEvent } from "../token_risk_scorer.ts";

export const SEQUENCE_LENGTH = 24;
export const SEQUENCE_FEATURES = [
  "holder_count",
  "liquidity_sol",
  "volume_sol",
  "buy_sell_ratio",
  "price_velocity"
] as const;

export type SequenceFeatureName = typeof SEQUENCE_FEATURES[number];
export type ModelSequence = number[][];

export interface TokenStateSnapshot {
  mint: string;
  timestamp: number;
  holderCount: number;
  liquiditySol: number;
  volumeSol: number;
  buySellRatio: number;
  priceVelocity: number;
}

interface SequenceSlot {
  hour: number;
  values: [number, number, number, number, number];
}

const emptyStep = (): [number, number, number, number, number] => [0, 0, 0, 1, 0];

export class SequenceBuffer {
  buffers = new Map<string, SequenceSlot[]>();
  maxTokens: number;

  constructor(maxTokens = 50_000) {
    this.maxTokens = maxTokens;
  }

  update(snapshot: TokenStateSnapshot): void {
    const hour = Math.floor(snapshot.timestamp / 3_600_000);
    const values: [number, number, number, number, number] = [
      Math.max(0, snapshot.holderCount),
      Math.max(0, snapshot.liquiditySol),
      Math.max(0, snapshot.volumeSol),
      Math.max(0, snapshot.buySellRatio),
      snapshot.priceVelocity
    ];
    const buffer = this.buffers.get(snapshot.mint) || [];
    const existing = buffer.find((slot) => slot.hour === hour);
    if (existing) {
      existing.values = values;
    } else {
      buffer.push({ hour, values });
      buffer.sort((a, b) => a.hour - b.hour);
      while (buffer.length > SEQUENCE_LENGTH) {
        buffer.shift();
      }
    }
    this.buffers.set(snapshot.mint, buffer);
    this.evictIfNeeded();
  }

  updateFromEvent(event: TokenLaunchEvent, holderCount = event.uniqueBuyers): void {
    this.update({
      mint: event.mint,
      timestamp: event.timestamp,
      holderCount,
      liquiditySol: event.liquiditySol,
      volumeSol: event.totalVolumeSol,
      buySellRatio: event.buySellRatio,
      priceVelocity: event.priceVelocity1m
    });
  }

  sequenceFor(mint: string, now = Date.now()): ModelSequence {
    const currentHour = Math.floor(now / 3_600_000);
    const byHour = new Map((this.buffers.get(mint) || []).map((slot) => [slot.hour, slot.values] as const));
    const output: ModelSequence = [];
    for (let offset = SEQUENCE_LENGTH - 1; offset >= 0; offset -= 1) {
      output.push([...(byHour.get(currentHour - offset) || emptyStep())]);
    }
    return output;
  }

  flattenFor(mint: string, now = Date.now()): Float32Array {
    return Float32Array.from(this.sequenceFor(mint, now).flat());
  }

  evict(mint: string): void {
    this.buffers.delete(mint);
  }

  private evictIfNeeded(): void {
    if (this.buffers.size <= this.maxTokens) {
      return;
    }
    const first = this.buffers.keys().next().value as string | undefined;
    if (first) {
      this.buffers.delete(first);
    }
  }
}
