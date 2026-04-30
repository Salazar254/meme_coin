/**
 * src/components/anomaly-detector.ts
 *
 * Autoencoder-based anomaly detection.
 * Trained on historical "normal" token launches.
 * Output: reconstructionError (0-1), isAnomaly flag (> 0.7)
 * Runs in parallel to ensemble for latency reasons.
 */

import { Logger } from 'pino';
import { spawn } from 'child_process';
import { SignalVector, AnomalyScore } from '../types';

export interface AnomalyDetectorConfig {
  modelPath: string; // Path to autoencoder model artifact
  pythonRuntimePath: string; // Python executable or server URL
  pythonModelServerUrl?: string; // If using HTTP server instead of subprocess
  anomalyThreshold: number; // 0.7 default
}

/**
 * Runs autoencoder inference to detect novel rug patterns.
 */
export class AnomalyDetector {
  private config: AnomalyDetectorConfig;
  private logger: Logger;
  private modelCache: Map<string, any> = new Map();

  constructor(config: AnomalyDetectorConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Main entry: run inference on signal vector.
   * Non-blocking, returns reconstruction error.
   */
  async detect(signals: SignalVector): Promise<AnomalyScore> {
    try {
      // Build normalized feature vector from SignalVector
      const featureVector = this.signalToFeatureVector(signals);

      // Call Python autoencoder (subprocess or HTTP)
      const reconstructionError = await this.runInference(featureVector);

      // Determine anomaly flag
      const isAnomaly = reconstructionError > this.config.anomalyThreshold;
      const noveltyFlag = isAnomaly ? 'ANOMALY_DETECTED' : 'NORMAL_PATTERN';

      this.logger.debug({
        msg: 'Anomaly detection result',
        tokenAddress: signals.tokenAddress,
        reconstructionError,
        isAnomaly,
      });

      return {
        reconstructionError,
        isAnomaly,
        noveltyFlag,
      };
    } catch (err) {
      this.logger.warn({
        msg: 'Anomaly detection failed, falling back to normal',
        error: String(err),
      });
      // Conservative fallback: not an anomaly if detector fails
      return {
        reconstructionError: 0.3,
        isAnomaly: false,
        noveltyFlag: 'DETECTOR_ERROR',
      };
    }
  }

  /**
   * Convert SignalVector to normalized feature vector for autoencoder
   */
  private signalToFeatureVector(signals: SignalVector): number[] {
    // Normalize all fields to 0-1 range
    return [
      signals.mintEnabled ? 1 : 0,
      signals.blacklistFunction ? 1 : 0,
      signals.ownershipRenounced ? 1 : 0,
      signals.isProxy ? 1 : 0,
      signals.isHoneypot ? 1 : 0,
      Math.min(signals.buyTax / 100, 1),
      Math.min(signals.sellTax / 100, 1),
      Math.min(signals.top10HolderPct / 100, 1),
      Math.min(signals.devWalletPct / 100, 1),
      signals.walletClusterScore,
      signals.lpLocked ? 1 : 0,
      Math.min(signals.lpLockDays / 365, 1),
      signals.lpBurned ? 1 : 0,
      signals.hasTelegram ? 1 : 0,
      signals.hasTwitter ? 1 : 0,
      Math.min(signals.telegramAgeDays / 365, 1),
      Math.min(signals.twitterAgeDays / 365, 1),
      signals.followerQualityScore,
      signals.isKnownRugDeployer ? 1 : 0,
    ];
  }

  /**
   * Run inference via Python subprocess or HTTP endpoint
   */
  private async runInference(features: number[]): Promise<number> {
    if (this.config.pythonModelServerUrl) {
      return this.runHttpInference(features);
    } else {
      return this.runSubprocessInference(features);
    }
  }

  /**
   * HTTP inference (model server running in separate process)
   */
  private async runHttpInference(features: number[]): Promise<number> {
    try {
      const response = await fetch(`${this.config.pythonModelServerUrl}/anomaly`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { reconstruction_error: number };
      return data.reconstruction_error;
    } catch (err) {
      this.logger.error({ msg: 'HTTP inference failed', error: String(err) });
      throw err;
    }
  }

  /**
   * Subprocess inference (call Python directly)
   * Expected Python script output: JSON line with reconstruction_error field
   */
  private async runSubprocessInference(features: number[]): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.pythonRuntimePath, [
        this.config.modelPath,
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
          return reject(new Error(`Autoencoder subprocess exited ${code}: ${stderr}`));
        }

        try {
          const result = JSON.parse(stdout);
          resolve(result.reconstruction_error);
        } catch (err) {
          reject(new Error(`Failed to parse autoencoder output: ${stdout}`));
        }
      });

      child.on('error', reject);
    });
  }
}
