import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface DeployerLookupOptions {
  unknownId?: number;
  hashFallbackBuckets?: number;
}

export class DeployerLookup {
  mapping: Map<string, number>;
  unknownId: number;
  hashFallbackBuckets: number;

  constructor(mapping: Record<string, number> = {}, options: DeployerLookupOptions = {}) {
    this.mapping = new Map(Object.entries(mapping));
    this.unknownId = options.unknownId ?? mapping.__unknown__ ?? 0;
    this.hashFallbackBuckets = options.hashFallbackBuckets ?? 0;
  }

  static async load(path = "models/deployer_lookup.json", options: DeployerLookupOptions = {}): Promise<DeployerLookup> {
    try {
      const raw = await readFile(resolve(path), "utf8");
      return new DeployerLookup(JSON.parse(raw) as Record<string, number>, options);
    } catch {
      return new DeployerLookup({ __unknown__: options.unknownId ?? 0 }, options);
    }
  }

  idFor(deployer: string | undefined): number {
    if (!deployer) {
      return this.unknownId;
    }
    const exact = this.mapping.get(deployer);
    if (exact !== undefined) {
      return exact;
    }
    if (this.hashFallbackBuckets <= 0) {
      return this.unknownId;
    }
    return 1 + stableHash(deployer) % this.hashFallbackBuckets;
  }
}

const stableHash = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};
