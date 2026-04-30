import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { MarketRegime, ScorerConfig } from "./config.ts";
import type { Logger } from "./utils/logger.ts";

export interface TokenLaunchEvent {
  mint: string;
  deployer: string;
  timestamp: number;
  liquiditySol: number;
  lpBurnPct: number;
  ageSeconds: number;
  uniqueBuyers: number;
  totalVolumeSol: number;
  marketCapSol: number;
  rugPullRisk: number;
  honeypotRisk: number;
  transferTaxPct: number;
  topHolderPct: number;
  devHoldPct: number;
  mutableMetadata: boolean;
  mintAuthorityRenounced: boolean;
  freezeAuthorityRenounced: boolean;
  volatility1m: number;
  priceVelocity1m: number;
  buySellRatio: number;
  jitoCompetition: number;
  launchRatePerMinute: number;
  predictedWinProb: number;
  rewardRiskRatio: number;
  futureReturnPct?: number;
  synthetic?: boolean;
}

export interface TokenRiskResult {
  accepted: boolean;
  riskProbability: number;
  mlConfidence: number;
  regime: MarketRegime;
  reasons: string[];
  rugcheck?: RugCheckSummary;
}

export interface RugCheckSummary {
  mint?: string;
  score?: number;
  riskLevel?: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  lpLocked?: boolean;
  lpLockedPct?: number;
  topHoldersPct?: number;
  risks?: Array<{ name?: string; level?: string; description?: string }>;
}

interface LinearModel {
  bias: number;
  weights: Record<string, number>;
  tfjsModelUrl?: string;
  featureOrder?: string[];
}

interface TensorLike {
  data(): Promise<Float32Array | number[]>;
  dispose(): void;
}

interface TfLike {
  tensor2d(values: number[][]): TensorLike;
  loadLayersModel(url: string): Promise<{ predict(input: TensorLike): TensorLike | TensorLike[] }>;
}

const clamp = (value: number, low = 0, high = 1): number => Math.max(low, Math.min(high, value));
const sigmoid = (value: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));

export class TokenRiskScorer {
  config: ScorerConfig;
  logger: Logger;
  model: LinearModel;
  tf?: TfLike;
  tfModel?: { predict(input: TensorLike): TensorLike | TensorLike[] };

  constructor(config: ScorerConfig, logger: Logger, model: LinearModel, tf?: TfLike, tfModel?: { predict(input: TensorLike): TensorLike | TensorLike[] }) {
    this.config = config;
    this.logger = logger.child({ component: "token_risk_scorer" });
    this.model = model;
    this.tf = tf;
    this.tfModel = tfModel;
  }

  static async load(modelPath: string, config: ScorerConfig, logger: Logger): Promise<TokenRiskScorer> {
    const resolvedPath = await resolveModelPath(modelPath);
    const raw = await readFile(resolvedPath, "utf8");
    const parsed = JSON.parse(raw) as LinearModel;
    if (typeof parsed.bias !== "number" || typeof parsed.weights !== "object") {
      throw new Error("invalid_rug_model");
    }
    if (parsed.tfjsModelUrl) {
      try {
        const tf = await import("@tensorflow/tfjs-node") as unknown as TfLike;
        const tfModel = await tf.loadLayersModel(parsed.tfjsModelUrl);
        logger.info({ modelPath: resolvedPath, tfjsModelUrl: parsed.tfjsModelUrl }, "tfjs_rug_model_loaded");
        return new TokenRiskScorer(config, logger, parsed, tf, tfModel);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ modelPath: resolvedPath, error: message }, "tfjs_model_unavailable_linear_fallback");
      }
    }
    logger.info({ modelPath: resolvedPath }, "rug_model_loaded");
    return new TokenRiskScorer(config, logger, parsed);
  }

  async evaluate(event: TokenLaunchEvent): Promise<TokenRiskResult> {
    const reasons: string[] = [];
    if (this.config.deployerBlacklist.has(event.deployer)) {
      reasons.push("blacklisted_deployer");
    }
    if (event.rugPullRisk > this.config.rugPullBlockThreshold) {
      reasons.push("rug_threshold");
    }
    if (event.lpBurnPct < this.config.minLpBurnPct) {
      reasons.push("lp_burn_below_90_pct");
    }
    if (event.honeypotRisk > this.config.honeypotRiskThreshold) {
      reasons.push("honeypot_risk");
    }
    if (event.transferTaxPct > this.config.maxTransferTaxPct) {
      reasons.push("transfer_tax");
    }

    const rugcheck = await this.fetchRugCheck(event);
    if (rugcheck) {
      if (typeof rugcheck.lpLockedPct === "number" && rugcheck.lpLockedPct < this.config.minLpBurnPct * 100) {
        reasons.push("rugcheck_lp_lock");
      }
      if (rugcheck.mintAuthority !== null && rugcheck.mintAuthority !== undefined) {
        reasons.push("rugcheck_mint_authority");
      }
      if (rugcheck.freezeAuthority !== null && rugcheck.freezeAuthority !== undefined) {
        reasons.push("rugcheck_freeze_authority");
      }
      if (rugcheck.risks?.some((risk) => ["danger", "critical"].includes(String(risk.level || "").toLowerCase()))) {
        reasons.push("rugcheck_danger");
      }
    }

    const riskProbability = await this.predict(event, rugcheck);
    if (riskProbability > this.config.rugProbBlockThreshold) {
      reasons.push("ml_risk_probability");
    }

    const regime = this.detectRegime(event, riskProbability);
    const mlConfidence = clamp(1 - riskProbability);
    return {
      accepted: reasons.length === 0,
      riskProbability,
      mlConfidence,
      regime,
      reasons,
      rugcheck
    };
  }

  async predict(event: TokenLaunchEvent, rugcheck?: RugCheckSummary): Promise<number> {
    const features = this.features(event, rugcheck);
    if (this.tf && this.tfModel && this.model.featureOrder) {
      const input = this.tf.tensor2d([this.model.featureOrder.map((key) => features[key] || 0)]);
      const prediction = this.tfModel.predict(input);
      const tensor = Array.isArray(prediction) ? prediction[0] : prediction;
      const data = await tensor.data();
      input.dispose();
      tensor.dispose();
      return clamp(Number(data[0]));
    }
    let score = this.model.bias;
    for (const [key, weight] of Object.entries(this.model.weights)) {
      score += (features[key] || 0) * weight;
    }
    return clamp(sigmoid(score));
  }

  features(event: TokenLaunchEvent, rugcheck?: RugCheckSummary): Record<string, number> {
    return {
      rugPullRisk: clamp(event.rugPullRisk),
      honeypotRisk: clamp(event.honeypotRisk),
      lpBurnGap: clamp(1 - event.lpBurnPct),
      transferTaxPct: clamp(event.transferTaxPct),
      topHolderPct: clamp(event.topHolderPct),
      devHoldPct: clamp(event.devHoldPct),
      mutableMetadata: event.mutableMetadata ? 1 : 0,
      mintAuthority: event.mintAuthorityRenounced ? 0 : 1,
      freezeAuthority: event.freezeAuthorityRenounced ? 0 : 1,
      volatility1m: clamp(event.volatility1m),
      lowLiquidity: clamp(1 / Math.max(event.liquiditySol, 0.05) / 5),
      lowBuyers: clamp(1 - event.uniqueBuyers / 40),
      rugcheckScore: clamp((rugcheck?.score || 0) / 10000),
      rugcheckTopHolders: clamp((rugcheck?.topHoldersPct || event.topHolderPct * 100) / 100)
    };
  }

  detectRegime(event: TokenLaunchEvent, riskProbability: number): MarketRegime {
    if (event.rugPullRisk > 0.08 || riskProbability > 0.1 || event.lpBurnPct < 0.95 || event.volatility1m > 0.72) {
      return "stress";
    }
    if (event.launchRatePerMinute > 1200 || event.jitoCompetition > 0.82) {
      return "burst";
    }
    if (event.volatility1m > 0.48 || event.buySellRatio < 0.82) {
      return "caution";
    }
    return "normal";
  }

  async fetchRugCheck(event: TokenLaunchEvent): Promise<RugCheckSummary | undefined> {
    if (!this.config.rugcheckEnabled || event.synthetic) {
      return undefined;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 900);
    try {
      const response = await fetch(`${this.config.rugcheckApiUrl.replace(/\/$/, "")}/v1/tokens/${event.mint}/report/summary`, {
        headers: this.config.rugcheckApiKey ? { authorization: `Bearer ${this.config.rugcheckApiKey}` } : {},
        signal: controller.signal
      });
      if (!response.ok) {
        this.logger.warn({ mint: event.mint, status: response.status }, "rugcheck_request_failed");
        return undefined;
      }
      return await response.json() as RugCheckSummary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ mint: event.mint, error: message }, "rugcheck_unavailable");
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

const resolveModelPath = async (modelPath: string): Promise<string> => {
  const candidates = [
    resolve(modelPath),
    resolve(`${modelPath}.json`),
    resolve("models", modelPath),
    resolve("models", `${modelPath}.json`)
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return candidates[0];
};
