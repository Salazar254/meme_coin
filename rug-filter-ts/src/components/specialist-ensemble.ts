/**
 * src/components/specialist-ensemble.ts
 *
 * Four specialist classifiers on independent signal subsets:
 *   - ContractModel: mint, honeypot, blacklist, proxy
 *   - WalletModel: holder concentration, deployer patterns
 *   - LiquidityModel: LP lock status, burn status, taxes
 *   - SocialModel: Telegram, Twitter, community signals
 *
 * Each returns: { score: 0-1, confidence: 0-1 }
 * Confidence weights decay if model accuracy drops week-over-week.
 */

import { Logger } from 'pino';
import { SignalVector, SpecialistPrediction, EnsembleResult } from '../types';
import { spawn } from 'child_process';

export interface SpecialistModelConfig {
  modelPath: string;
  pythonRuntimePath: string;
  pythonModelServerUrl?: string;
}

export interface SpecialistConfig {
  contractModel: SpecialistModelConfig;
  walletModel: SpecialistModelConfig;
  liquidityModel: SpecialistModelConfig;
  socialModel: SpecialistModelConfig;
  
  // Accuracy tracking for confidence decay
  accuracyTrackingWindowDays: number; // 7 for weekly
}

/**
 * Specialist ensemble coordinator
 */
export class SpecialistEnsemble {
  private config: SpecialistConfig;
  private logger: Logger;
  
  // Rolling accuracy per specialist (for confidence weighting)
  private accuracyHistory: Map<string, number[]> = new Map();

  constructor(config: SpecialistConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    
    // Initialize accuracy history for each specialist
    ['ContractModel', 'WalletModel', 'LiquidityModel', 'SocialModel'].forEach(
      (name) => this.accuracyHistory.set(name, []),
    );
  }

  /**
   * Run all four specialists in parallel.
   * Returns ensemble score (0-1) + individual predictions.
   */
  async predict(signals: SignalVector): Promise<EnsembleResult> {
    const startTime = Date.now();

    // Run all specialists in parallel
    const [contractPred, walletPred, liquidityPred, socialPred] = await Promise.all([
      this.runContractModel(signals),
      this.runWalletModel(signals),
      this.runLiquidityModel(signals),
      this.runSocialModel(signals),
    ]);

    // Compute confidence-adjusted weights
    const contractWeight = 0.35 * this.getConfidenceMultiplier('ContractModel');
    const walletWeight = 0.30 * this.getConfidenceMultiplier('WalletModel');
    const liquidityWeight = 0.25 * this.getConfidenceMultiplier('LiquidityModel');
    const socialWeight = 0.10 * this.getConfidenceMultiplier('SocialModel');

    // Normalize weights
    const totalWeight = contractWeight + walletWeight + liquidityWeight + socialWeight;
    const normContractWeight = contractWeight / totalWeight;
    const normWalletWeight = walletWeight / totalWeight;
    const normLiquidityWeight = liquidityWeight / totalWeight;
    const normSocialWeight = socialWeight / totalWeight;

    // Weighted ensemble score
    const ensembleScore =
      contractPred.score * normContractWeight +
      walletPred.score * normWalletWeight +
      liquidityPred.score * normLiquidityWeight +
      socialPred.score * normSocialWeight;

    // Confidence-adjusted score (average confidence weighted)
    const avgConfidence =
      contractPred.confidence * normContractWeight +
      walletPred.confidence * normWalletWeight +
      liquidityPred.confidence * normLiquidityWeight +
      socialPred.confidence * normSocialWeight;

    const confidenceAdjustedScore = ensembleScore * avgConfidence;

    // Check for conflict: if top 2 models disagree > 30 pts
    const scores = [contractPred.score, walletPred.score, liquidityPred.score, socialPred.score];
    scores.sort((a, b) => b - a);
    const conflictFlag = scores.length >= 2 && scores[0] - scores[1] > 0.3;

    const inferenceTimeMs = Date.now() - startTime;

    this.logger.debug({
      msg: 'Ensemble prediction complete',
      tokenAddress: signals.tokenAddress,
      ensembleScore: ensembleScore.toFixed(3),
      confidenceAdjustedScore: confidenceAdjustedScore.toFixed(3),
      conflictFlag,
      inferenceTimeMs,
    });

    return {
      contractPred,
      walletPred,
      liquidityPred,
      socialPred,
      ensembleScore,
      confidenceAdjustedScore,
      conflictFlag,
    };
  }

  /**
   * Update accuracy history after labeling
   * Call this when feedback is received
   */
  updateAccuracy(modelName: string, accuracy: number): void {
    const history = this.accuracyHistory.get(modelName) || [];
    history.push(accuracy);

    // Keep only last N days of accuracy
    const maxHistorySize = 7; // rolling 7-day window
    if (history.length > maxHistorySize) {
      history.shift();
    }

    this.accuracyHistory.set(modelName, history);
  }

  /**
   * Get confidence multiplier based on recent accuracy
   * If accuracy has dropped > 15% vs prior week → reduce weight
   */
  private getConfidenceMultiplier(modelName: string): number {
    const history = this.accuracyHistory.get(modelName) || [];

    if (history.length < 2) {
      return 1.0; // Full confidence if insufficient history
    }

    const recentAccuracy = history.slice(-1)[0];
    const priorAccuracy = history[0];

    const accuracyDrop = priorAccuracy - recentAccuracy;

    if (accuracyDrop > 0.15) {
      // Confidence decay: linear interpolation
      // -15% drop = 0.85x weight, -30% drop = 0.5x weight
      return Math.max(0.5, 1.0 - accuracyDrop);
    }

    return 1.0;
  }

  /**
   * Contract Specialist: mint, honeypot, blacklist, proxy
   */
  private async runContractModel(signals: SignalVector): Promise<SpecialistPrediction> {
    const features = [
      signals.mintEnabled ? 1 : 0,
      signals.blacklistFunction ? 1 : 0,
      signals.ownershipRenounced ? 1 : 0,
      signals.isProxy ? 1 : 0,
      signals.isHoneypot ? 1 : 0,
    ];

    const prediction = await this.runPythonModel(
      this.config.contractModel,
      features,
      'Contract',
    );

    return {
      modelName: 'ContractModel',
      score: prediction.score,
      confidence: prediction.confidence,
      reasoning: `Contract safety: mint=${signals.mintEnabled}, honeypot=${signals.isHoneypot}`,
    };
  }

  /**
   * Wallet Specialist: holder concentration, deployer patterns
   */
  private async runWalletModel(signals: SignalVector): Promise<SpecialistPrediction> {
    const features = [
      Math.min(signals.top10HolderPct / 100, 1),
      Math.min(signals.devWalletPct / 100, 1),
      signals.walletClusterScore,
      signals.isKnownRugDeployer ? 1 : 0,
    ];

    const prediction = await this.runPythonModel(
      this.config.walletModel,
      features,
      'Wallet',
    );

    return {
      modelName: 'WalletModel',
      score: prediction.score,
      confidence: prediction.confidence,
      reasoning: `Holder distribution: top10=${signals.top10HolderPct.toFixed(1)}%, concentration=${signals.walletClusterScore.toFixed(2)}`,
    };
  }

  /**
   * Liquidity Specialist: LP lock, burn, taxes
   */
  private async runLiquidityModel(signals: SignalVector): Promise<SpecialistPrediction> {
    const features = [
      signals.lpLocked ? 1 : 0,
      Math.min(signals.lpLockDays / 365, 1),
      signals.lpBurned ? 1 : 0,
      Math.min(signals.buyTax / 100, 1),
      Math.min(signals.sellTax / 100, 1),
    ];

    const prediction = await this.runPythonModel(
      this.config.liquidityModel,
      features,
      'Liquidity',
    );

    return {
      modelName: 'LiquidityModel',
      score: prediction.score,
      confidence: prediction.confidence,
      reasoning: `LP status: locked=${signals.lpLocked}, lockDays=${signals.lpLockDays}, sellTax=${signals.sellTax}%`,
    };
  }

  /**
   * Social Specialist: Telegram, Twitter, community
   */
  private async runSocialModel(signals: SignalVector): Promise<SpecialistPrediction> {
    const features = [
      signals.hasTelegram ? 1 : 0,
      signals.hasTwitter ? 1 : 0,
      Math.min(signals.telegramAgeDays / 365, 1),
      Math.min(signals.twitterAgeDays / 365, 1),
      signals.followerQualityScore,
    ];

    const prediction = await this.runPythonModel(
      this.config.socialModel,
      features,
      'Social',
    );

    return {
      modelName: 'SocialModel',
      score: prediction.score,
      confidence: prediction.confidence,
      reasoning: `Community: telegram=${signals.hasTelegram}, twitter=${signals.hasTwitter}`,
    };
  }

  /**
   * Generic Python model runner (HTTP or subprocess)
   */
  private async runPythonModel(
    modelConfig: SpecialistModelConfig,
    features: number[],
    modelType: string,
  ): Promise<{ score: number; confidence: number }> {
    try {
      if (modelConfig.pythonModelServerUrl) {
        return await this.runHttpModel(modelConfig, features, modelType);
      } else {
        return await this.runSubprocessModel(modelConfig, features, modelType);
      }
    } catch (err) {
      this.logger.warn({
        msg: `${modelType} model inference failed`,
        error: String(err),
      });
      // Fallback: neutral prediction
      return { score: 0.5, confidence: 0.3 };
    }
  }

  /**
   * HTTP model inference
   */
  private async runHttpModel(
    modelConfig: SpecialistModelConfig,
    features: number[],
    modelType: string,
  ): Promise<{ score: number; confidence: number }> {
    const response = await fetch(`${modelConfig.pythonModelServerUrl}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: modelType.toLowerCase(), features }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { score: number; confidence: number };
    return data;
  }

  /**
   * Subprocess model inference
   */
  private async runSubprocessModel(
    modelConfig: SpecialistModelConfig,
    features: number[],
    modelType: string,
  ): Promise<{ score: number; confidence: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(modelConfig.pythonRuntimePath, [
        modelConfig.modelPath,
        JSON.stringify(features),
      ]);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`${modelType} model exited ${code}: ${stderr}`));
        }

        try {
          const result = JSON.parse(stdout);
          resolve({ score: result.score, confidence: result.confidence });
        } catch (err) {
          reject(new Error(`Failed to parse ${modelType} model output: ${stdout}`));
        }
      });

      child.on('error', reject);
    });
  }
}
