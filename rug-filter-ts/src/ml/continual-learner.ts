/**
 * src/ml/continual-learner.ts
 *
 * Elastic Weight Consolidation (EWC) for continual learning.
 * Protects important weights while enabling fast adaptation.
 *
 * Weekly retraining cycle:
 *   1. Collect labeled feedback (last 30 days)
 *   2. Compute Fisher Information Matrix (measures weight importance)
 *   3. Retrain with EWC regularization
 *   4. Validate on time-split data
 *   5. Deploy only if accuracy delta >= -3%
 */

import { Logger } from 'pino';
import { spawn } from 'child_process';
import { FeedbackRecord, RetrainReport } from '../types';
import { FeedbackLogger } from '../persistence/feedback-logger';

export interface EWCConfig {
  pythonRuntimePath: string;
  modelPath: string;
  pythonModelServerUrl?: string;
  
  // EWC parameters
  fisherPenaltyFactor: number; // λ in EWC formula
  
  // Retraining
  minFeedbackRecordsForRetrain: number; // 100+
  trainingEpochs: number;
  batchSize: number;
  
  // Validation
  timeSplitDays: number; // 7 = validate on last 7 days
  accuracyEpsilonPct: number; // -3% = -0.03
}

/**
 * Continual Learner: EWC-based retraining
 */
export class ContinualLearner {
  private config: EWCConfig;
  private logger: Logger;
  private feedbackLogger: FeedbackLogger;
  private retrainCycleCount: number = 0;

  constructor(
    config: EWCConfig,
    feedbackLogger: FeedbackLogger,
    logger: Logger,
  ) {
    this.config = config;
    this.feedbackLogger = feedbackLogger;
    this.logger = logger;
  }

  /**
   * Main entry: trigger retraining cycle
   */
  async retrain(): Promise<RetrainReport> {
    this.logger.info({ msg: 'Starting retrain cycle' });
    const startTime = Date.now();
    this.retrainCycleCount++;

    // 1. Collect training data (last 30 days, labeled)
    const allData = this.feedbackLogger.getLabeledFeedback(Date.now(), 10000);
    const trainingData = allData.slice(0, Math.floor(allData.length * 0.7));
    const validationData = allData.slice(Math.floor(allData.length * 0.7));

    if (trainingData.length < this.config.minFeedbackRecordsForRetrain) {
      this.logger.warn({
        msg: 'Not enough feedback records for retraining',
        available: trainingData.length,
        required: this.config.minFeedbackRecordsForRetrain,
      });

      return {
        retrainCycle: this.retrainCycleCount,
        timestamp: Date.now(),
        trainingRecords: trainingData.length,
        validationRecords: validationData.length,
        labeledRecords: allData.length,
        modelAccuracyBefore: 0.5,
        modelAccuracyAfter: 0.5,
        accuracyDelta: 0,
        validationAccuracy: 0.5,
        specialistDeltas: {},
        deployed: false,
      };
    }

    this.logger.info({
      msg: 'Retrain data collected',
      trainingRecords: trainingData.length,
      validationRecords: validationData.length,
    });

    // 2. Call Python retraining script with EWC
    const retrainResult = await this.callPythonRetrain(trainingData, validationData);

    // 3. Check if accuracy improved enough to deploy
    const accuracyDelta = retrainResult.modelAccuracyAfter - retrainResult.modelAccuracyBefore;
    const shouldDeploy = accuracyDelta > this.config.accuracyEpsilonPct;

    if (shouldDeploy) {
      this.logger.info({
        msg: 'New model approved for deployment',
        accuracyBefore: retrainResult.modelAccuracyBefore.toFixed(3),
        accuracyAfter: retrainResult.modelAccuracyAfter.toFixed(3),
        delta: accuracyDelta.toFixed(3),
      });
    } else {
      this.logger.warn({
        msg: 'New model did not meet accuracy threshold',
        accuracyBefore: retrainResult.modelAccuracyBefore.toFixed(3),
        accuracyAfter: retrainResult.modelAccuracyAfter.toFixed(3),
        delta: accuracyDelta.toFixed(3),
        required: this.config.accuracyEpsilonPct.toFixed(3),
      });
    }

    const retrainTimeMs = Date.now() - startTime;

    const report: RetrainReport = {
      retrainCycle: this.retrainCycleCount,
      timestamp: Date.now(),
      trainingRecords: trainingData.length,
      validationRecords: validationData.length,
      labeledRecords: allData.length,
      modelAccuracyBefore: retrainResult.modelAccuracyBefore,
      modelAccuracyAfter: retrainResult.modelAccuracyAfter,
      accuracyDelta,
      validationAccuracy: retrainResult.validationAccuracy,
      specialistDeltas: retrainResult.specialistDeltas,
      ewcFisherStats: retrainResult.ewcFisherStats,
      regimeState: retrainResult.regimeState,
      deployed: shouldDeploy,
    };

    this.logger.info({
      msg: 'Retrain cycle complete',
      cycleTime: retrainTimeMs.toFixed(0),
      deployed: shouldDeploy,
    });

    return report;
  }

  /**
   * Call Python retraining subprocess with EWC
   */
  private async callPythonRetrain(
    trainingData: FeedbackRecord[],
    validationData: FeedbackRecord[],
  ): Promise<any> {
    // Prepare training data format: [features, labels, reward_signal, ...]
    const trainingDataset = this.formatDataset(trainingData);
    const validationDataset = this.formatDataset(validationData);

    return new Promise((resolve, reject) => {
      const args = [
        this.config.modelPath,
        '--training-data', JSON.stringify(trainingDataset),
        '--validation-data', JSON.stringify(validationDataset),
        '--fisher-penalty', this.config.fisherPenaltyFactor.toString(),
        '--epochs', this.config.trainingEpochs.toString(),
        '--batch-size', this.config.batchSize.toString(),
      ];

      const child = spawn(this.config.pythonRuntimePath, args);

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
          return reject(new Error(`Retrain exited ${code}: ${stderr}`));
        }

        try {
          const result = JSON.parse(stdout);
          resolve({
            modelAccuracyBefore: result.accuracy_before,
            modelAccuracyAfter: result.accuracy_after,
            validationAccuracy: result.validation_accuracy,
            specialistDeltas: result.specialist_deltas || {},
            ewcFisherStats: result.ewc_fisher_stats,
            regimeState: result.regime_state,
          });
        } catch (err) {
          reject(new Error(`Failed to parse retrain output: ${stdout}`));
        }
      });

      child.on('error', reject);
    });
  }

  /**
   * Format feedback records for ML training
   */
  private formatDataset(data: FeedbackRecord[]): any[] {
    return data.map((record) => ({
      features: this.signalToFeatures(record.signalVector),
      label: this.outcomeToLabel(record.outcome),
      reward: record.rewardSignal || 0,
      tokenAddress: record.tokenAddress,
      timestamp: record.timestamp,
    }));
  }

  /**
   * Convert SignalVector to feature array
   */
  private signalToFeatures(signals: any): number[] {
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
   * Convert outcome to binary label
   * RUG/DUMP_60 = 1, STABLE/MOONSHOT = 0
   */
  private outcomeToLabel(outcome?: string): number {
    if (!outcome) return 0.5; // Unknown
    if (outcome === 'RUG' || outcome === 'DUMP_60') return 1;
    return 0;
  }
}
