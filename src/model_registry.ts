import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ModelStatus = "active" | "shadow" | "candidate" | "retired";

export interface ModelVersion {
  id: string;
  path: string;
  status: ModelStatus;
  trafficPct: number;
  valAuc?: number;
  promotedAt?: string;
  createdAt: string;
}

export interface RegistryFile {
  activeModelId: string;
  rollbackModelId?: string;
  versions: ModelVersion[];
}

export class ModelRegistry {
  path: string;
  state: RegistryFile;

  constructor(path = "./models/registry.json", state?: RegistryFile) {
    this.path = path;
    this.state = state || { activeModelId: "rug_model_v1", versions: [] };
  }

  static async load(path = "./models/registry.json"): Promise<ModelRegistry> {
    try {
      const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as RegistryFile;
      return new ModelRegistry(path, parsed);
    } catch {
      return new ModelRegistry(path);
    }
  }

  active(): ModelVersion | undefined {
    return this.state.versions.find((version) => version.id === this.state.activeModelId);
  }

  route(mint: string): ModelVersion | undefined {
    const active = this.active();
    const rollout = this.state.versions.find((version) => version.status === "candidate" && version.trafficPct > 0);
    if (!rollout) {
      return active;
    }
    return stablePercent(mint) < rollout.trafficPct ? rollout : active;
  }

  shadowModels(): ModelVersion[] {
    return this.state.versions.filter((version) => version.status === "shadow");
  }

  setRollout(modelId: string, trafficPct: 10 | 50 | 100): void {
    for (const version of this.state.versions) {
      if (version.id === modelId) {
        version.status = trafficPct === 100 ? "active" : "candidate";
        version.trafficPct = trafficPct;
        if (trafficPct === 100) {
          this.state.rollbackModelId = this.state.activeModelId;
          this.state.activeModelId = version.id;
          version.promotedAt = new Date().toISOString();
        }
      }
    }
  }

  rollback(): void {
    if (!this.state.rollbackModelId) {
      return;
    }
    const rollback = this.state.versions.find((version) => version.id === this.state.rollbackModelId);
    if (!rollback) {
      return;
    }
    this.state.activeModelId = rollback.id;
    rollback.status = "active";
    rollback.trafficPct = 100;
    for (const version of this.state.versions) {
      if (version.id !== rollback.id && version.status === "active") {
        version.status = "retired";
        version.trafficPct = 0;
      }
    }
  }

  shouldRollback(errorRate: number, pnlDegraded: boolean): boolean {
    return errorRate > 0.01 || pnlDegraded;
  }

  async save(): Promise<void> {
    const resolved = resolve(this.path);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }
}

const stablePercent = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
};
