/**
 * src/orchestrator/rug-filter-orchestrator.ts
 *
 * Main orchestrator: coordinates all components
 * - Parallel signal extraction + anomaly detection
 * - Ensemble + rule engine + regime detector
 * - Confidence calibration + decision output
 * - Feedback logging for continual learning
 */

import { Logger } from 'pino';
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';

import {
  RugFilterConfig,
  SignalVector,
  RugFilterDecision,
  PortfolioContext,
} from '../types';

import { TokenSignalExtractor } from '../data-layer/token-signal-extractor';
import { AnomalyDetector } from '../components/anomaly-detector';
import { SpecialistEnsemble } from '../components/specialist-ensemble';
import { HardRuleEngine } from '../components/hard-rule-engine';
import { RegimeDetector } from '../components/regime-detector';
import { ConfidenceCalibrator } from '../components/confidence-calibrator';
import { FeedbackLogger } from '../persistence/feedback-logger';
import { MemoryArchitecture } from '../memory/memory-architecture';
import { ContinualLearner } from '../ml/continual-learner';

/**
 * Main orchestrator class
 */
export class RugFilterOrchestrator extends EventEmitter {
  private config: RugFilterConfig;
  private logger: Logger;
  private db: Database.Database;

  // Components
  private signalExtractor: TokenSignalExtractor;
  private anomalyDetector: AnomalyDetector;
  private ensemble: SpecialistEnsemble;
  private ruleEngine: HardRuleEngine;
  private regimeDetector: RegimeDetector;
  private calibrator: ConfidenceCalibrator;
  private feedbackLogger: FeedbackLogger;
  private memory: MemoryArchitecture;
  private continualLearner: ContinualLearner;

  // State
  private retrainSchedule: ReturnType<typeof setInterval> | null = null;
  private regimeCheckSchedule: ReturnType<typeof setInterval> | null = null;

  constructor(config: RugFilterConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;

    // Initialize database
    this.db = new Database(config.feedbackDbPath);
    this.db.pragma('journal_mode = WAL');

    // Initialize components
    this.signalExtractor = new TokenSignalExtractor(
      {
        goPlusApiKey: config.goPlusApiKey,
        honeypotApiKey: config.honeypotApiKey,
        heliusApiKey: config.heliusApiKey,
        alchemyApiKey: config.alchemyApiKey,
        unicryptApiKey: config.unicryptApiKey,
        apiTimeoutMs: config.apiCallTimeout,
        maxConcurrentRequests: config.maxConcurrentApis,
        knownRugDeployers: new Set(),
        knownWhitelistedDeployers: new Set(),
      },
      logger,
    );

    this.anomalyDetector = new AnomalyDetector(
      {
        modelPath: config.anomalyDetectorModelPath,
        pythonRuntimePath: config.pythonRuntimePath,
        pythonModelServerUrl: config.pythonModelServerUrl,
        anomalyThreshold: config.anomalyThreshold,
      },
      logger,
    );

    this.ensemble = new SpecialistEnsemble(
      {
        contractModel: { modelPath: config.contractModelPath, pythonRuntimePath: config.pythonRuntimePath },
        walletModel: { modelPath: config.walletModelPath, pythonRuntimePath: config.pythonRuntimePath },
        liquidityModel: { modelPath: config.liquidityModelPath, pythonRuntimePath: config.pythonRuntimePath },
        socialModel: { modelPath: config.socialModelPath, pythonRuntimePath: config.pythonRuntimePath },
        accuracyTrackingWindowDays: 7,
      },
      logger,
    );

    this.ruleEngine = new HardRuleEngine(logger);

    this.regimeDetector = new RegimeDetector(
      {
        dbPath: config.feedbackDbPath,
        missRateIncreaseThreshold: 0.15,
        regimeCheckIntervalMs: 60 * 60 * 1000, // 1hr
        informationGainDecayThreshold: 0.2,
      },
      this.db,
      logger,
    );

    this.calibrator = new ConfidenceCalibrator(undefined, logger);

    this.feedbackLogger = new FeedbackLogger(config.feedbackDbPath, logger);

    this.memory = new MemoryArchitecture(logger);

    this.continualLearner = new ContinualLearner(
      {
        pythonRuntimePath: config.pythonRuntimePath,
        modelPath: config.contractModelPath,
        fisherPenaltyFactor: config.ewcFisherPenaltyFactor,
        minFeedbackRecordsForRetrain: config.minFeedbackRecordsForRetrain,
        trainingEpochs: 20,
        batchSize: 32,
        timeSplitDays: 7,
        accuracyEpsilonPct: -0.03,
      },
      this.feedbackLogger,
      logger,
    );

    this.logger.info({
      msg: 'RugFilterOrchestrator initialized',
      components: [
        'SignalExtractor',
        'AnomalyDetector',
        'SpecialistEnsemble',
        'HardRuleEngine',
        'RegimeDetector',
        'ConfidenceCalibrator',
        'FeedbackLogger',
        'MemoryArchitecture',
        'ContinualLearner',
      ],
    });
  }

  /**
   * Main entry point: evaluate token for rug risk
   *
   * COGNITIVE ARCHITECTURE:
   * TokenSignals → AnomalyDetector → SpecialistEnsemble → RegimeDetector
   *                                        ↓
   *                                HardRuleEngine (floor)
   *                                        ↓
   *                          ConfidenceCalibrator
   *                                        ↓
   *                            RugFilterDecision
   *                                        ↓
   *                          FeedbackLogger (outcome 48h later)
   *                                        ↓
   *                          ContinualLearner (EWC updates)
   */
  async evaluateToken(
    tokenAddress: string,
    chain: 'solana' | 'ethereum' | 'polygon' = 'solana',
    portfolio?: PortfolioContext,
  ): Promise<RugFilterDecision> {
    const startTime = Date.now();

    try {
      // 1. REFRESH MEMORY (STM daily TTL)
      this.memory.refreshSTM();

      // 2. EXTRACT SIGNALS (parallel with 300ms timeout per API)
      const signalResult = await this.signalExtractor.extractSignals(tokenAddress, chain);
      const signals = signalResult.signals;

      // 3. RUN PARALLEL DETECTORS
      // - Anomaly detection (autoencoder) runs in parallel
      // - Ensemble (4 specialists) runs in parallel
      const [anomalyScore, ensembleResult] = await Promise.all([
        this.anomalyDetector.detect(signals),
        this.ensemble.predict(signals),
      ]);

      // 4. CHECK HARD RULES (can short-circuit to REJECT)
      const hardRuleResult = this.ruleEngine.evaluate(signals);

      // 5. BLEND SCORES (rule floor + ensemble)
      const blendedScore = this.ruleEngine.blendScores(
        hardRuleResult.ruleScore,
        ensembleResult.ensembleScore,
      );

      // Add anomaly penalty if novel pattern detected
      let finalScore = blendedScore;
      if (anomalyScore.isAnomaly) {
        finalScore += 20; // Force +20 pts on anomaly
        finalScore = Math.min(finalScore, 100);
      }

      // 6. CHECK REGIME SHIFT & SUGGEST WEIGHT ADJUSTMENTS
      const regimeState = await this.regimeDetector.evaluate();

      // 7. CALIBRATE DECISION (score → decision + position size)
      const calibrationResult = this.calibrator.calibrate(
        finalScore,
        portfolio,
        ensembleResult.conflictFlag,
      );

      // 8. BUILD FINAL DECISION
      const decision: RugFilterDecision = {
        tokenAddress,
        timestamp: Date.now(),
        hardRuleScore: hardRuleResult.ruleScore,
        ensembleScore: ensembleResult.ensembleScore * 100,
        anomalyScore: anomalyScore.reconstructionError,
        finalScore,
        decision: calibrationResult.decision,
        riskLevel: calibrationResult.riskLevel,
        positionSize: calibrationResult.positionSize,
        riskAdjustment: portfolio ? this.getDrawdownMultiplier(portfolio) : 1.0,
        conflictFlag: ensembleResult.conflictFlag,
        anomalyFlag: anomalyScore.isAnomaly,
        regimeShiftFlag: regimeState.shiftDetected,
        confidence: ensembleResult.confidenceAdjustedScore,
        signalVector: signals,
        ensemble: ensembleResult,
      };

      // 9. LOG DECISION & OUTCOME 48H LATER
      this.feedbackLogger.logDecision(signals, decision);

      // Emit event for subscribers
      this.emit('decision', decision);

      // Log summary
      const elapsed = Date.now() - startTime;
      this.logger.info({
        msg: 'Token evaluated',
        tokenAddress,
        decision: decision.decision,
        score: decision.finalScore.toFixed(1),
        positionSize: decision.positionSize.toFixed(2),
        elapsed,
        anomalyFlag: decision.anomalyFlag,
        regimeShiftFlag: decision.regimeShiftFlag,
      });

      return decision;
    } catch (err) {
      this.logger.error({
        msg: 'Evaluation failed',
        tokenAddress,
        error: String(err),
      });

      // Fallback conservative decision
      return {
        tokenAddress,
        timestamp: Date.now(),
        hardRuleScore: 50,
        ensembleScore: 50,
        anomalyScore: 0.5,
        finalScore: 60,
        decision: 'SKIP',
        riskLevel: 'HIGH',
        positionSize: 0,
        confidence: 0,
        signalVector: {} as SignalVector,
        ensemble: {} as any,
      };
    }
  }

  /**
   * Label outcome for decision (48h later)
   */
  async labelOutcome(
    tokenAddress: string,
    timestamp: number,
    outcome: 'RUG' | 'DUMP_60' | 'STABLE' | 'MOONSHOT',
  ): Promise<void> {
    this.feedbackLogger.labelOutcome(tokenAddress, timestamp, outcome);

    // Emit event
    this.emit('outcome', { tokenAddress, timestamp, outcome });

    this.logger.info({
      msg: 'Outcome labeled',
      tokenAddress,
      outcome,
    });
  }

  /**
   * Trigger retraining cycle (called weekly or on-demand)
   */
  async retrain(): Promise<void> {
    try {
      const report = await this.continualLearner.retrain();

      this.emit('retrain', report);

      if (report.deployed) {
        this.logger.info({
          msg: 'New model deployed',
          cycle: report.retrainCycle,
          accuracyDelta: report.accuracyDelta.toFixed(3),
        });
      }
    } catch (err) {
      this.logger.error({
        msg: 'Retraining failed',
        error: String(err),
      });
    }
  }

  /**
   * Start background processes
   */
  start(): void {
    // Retrain weekly
    this.retrainSchedule = setInterval(() => {
      this.retrain().catch((err) => {
        this.logger.error({ msg: 'Background retrain failed', error: String(err) });
      });
    }, 7 * 24 * 60 * 60 * 1000); // 7 days

    // Check regime every hour
    this.regimeCheckSchedule = setInterval(async () => {
      try {
        const regime = await this.regimeDetector.evaluate();
        if (regime.shiftDetected) {
          this.emit('regime-shift', regime);
          this.logger.warn({ msg: 'Regime shift detected', regime });
        }
      } catch (err) {
        this.logger.warn({ msg: 'Regime check failed', error: String(err) });
      }
    }, 60 * 60 * 1000); // 1 hour

    this.logger.info({ msg: 'RugFilterOrchestrator background processes started' });
  }

  /**
   * Stop background processes
   */
  stop(): void {
    if (this.retrainSchedule) clearInterval(this.retrainSchedule);
    if (this.regimeCheckSchedule) clearInterval(this.regimeCheckSchedule);

    this.feedbackLogger.close();
    this.db.close();

    this.logger.info({ msg: 'RugFilterOrchestrator stopped' });
  }

  /**
   * Get statistics
   */
  getStats() {
    const feedbackStats = this.feedbackLogger.getStatistics?.() || {
      totalDecisions: 0,
      labeledDecisions: 0,
      unlabeledDecisions: 0,
      avgRewardSignal: 0,
      outcomeCounts: {},
    };

    const memoryStats = this.memory.getStats();
    const regime = this.regimeDetector.getState();

    return {
      feedback: feedbackStats,
      memory: memoryStats,
      regime,
    };
  }

  /**
   * Helper: compute DD multiplier for position sizing
   */
  private getDrawdownMultiplier(portfolio: PortfolioContext): number {
    if (portfolio.currentDrawdownPct > 20) return 0.5;
    if (portfolio.currentDrawdownPct > 10) return 1.0;
    return 1.0;
  }
}
