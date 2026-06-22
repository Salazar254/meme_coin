/**
 * src/index.ts
 *
 * Main export and initialization
 */

import pino from 'pino';

import { RugFilterOrchestrator } from './orchestrator/rug-filter-orchestrator';
import { RugFilterConfig, RugFilterDecision } from './types';
import { TokenSignalExtractor } from './data-layer/token-signal-extractor';
import { HardRuleEngine } from './components/hard-rule-engine';
import { RegimeDetector } from './components/regime-detector';
import { SpecialistEnsemble } from './components/specialist-ensemble';
import { ConfidenceCalibrator } from './components/confidence-calibrator';

// Export all types and components
export * from './types';
export * from './orchestrator/rug-filter-orchestrator';
export * from './components/hard-rule-engine';
export * from './components/specialist-ensemble';
export * from './components/anomaly-detector';
export * from './components/confidence-calibrator';
export * from './components/regime-detector';
export * from './data-layer/token-signal-extractor';
export * from './persistence/feedback-logger';
export * from './ml/continual-learner';
export * from './memory/memory-architecture';

/**
 * Factory: create and configure orchestrator
 */
export function createRugFilter(
  config: RugFilterConfig,
  logLevel: 'debug' | 'info' | 'warn' | 'error' = 'info',
): RugFilterOrchestrator {
  const logger = pino({
    level: logLevel,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: false,
        messageFormat: '{levelLabel} [{time}] {msg}',
      },
    },
  });

  return new RugFilterOrchestrator(config, logger);
}

/**
 * Example usage
 */
export async function exampleUsage() {
  const config: RugFilterConfig = {
    goPlusApiKey: process.env.GOPLUS_API_KEY,
    honeypotApiKey: process.env.HONEYPOT_API_KEY,
    heliusApiKey: process.env.HELIUS_API_KEY,

    anomalyDetectorModelPath: './models/autoencoder.pt',
    contractModelPath: './models/contract_model.pkl',
    walletModelPath: './models/wallet_model.pkl',
    liquidityModelPath: './models/liquidity_model.pkl',
    socialModelPath: './models/social_model.pkl',

    pythonRuntimePath: 'python',
    pythonModelServerUrl: 'http://localhost:5000',

    feedbackDbPath: './feedback.db',

    signalExtractionTimeout: 2000,
    apiCallTimeout: 300,
    maxConcurrentApis: 5,

    anomalyThreshold: 0.7,
    conflictThreshold: 30,

    retrainIntervalDays: 7,
    minFeedbackRecordsForRetrain: 100,
    ewcFisherPenaltyFactor: 0.4,

    maxDrawdownPct: 35,

    logLevel: 'INFO',
  };

  // Create orchestrator
  const rugFilter = createRugFilter(config);

  // Start background processes
  rugFilter.start();

  // Listen to events
  rugFilter.on('decision', (decision) => {
    console.log('📊 Decision:', decision.decision, `Score: ${decision.finalScore.toFixed(1)}`);
  });

  rugFilter.on('outcome', (outcome) => {
    console.log('📈 Outcome:', outcome.outcome);
  });

  rugFilter.on('regime-shift', (regime) => {
    console.log('⚠️ Regime shift detected!', regime);
  });

  rugFilter.on('retrain', (report) => {
    console.log('🔄 Retrain complete:', report.accuracyDelta.toFixed(3));
  });

  // Example evaluation
  const decision = await rugFilter.evaluateToken(
    'So11111111111111111111111111111111111111112',
    'solana',
  );

  console.log('Decision:', decision);

  // Cleanup
  rugFilter.stop();
}

if (require.main === module) {
  exampleUsage().catch(console.error);
}

/**
 * High-throughput pipeline: wires together extraction → filter → rank → size → execute
 * Uses actual existing components from the codebase.
 */
export class HighThroughputPipeline {
  constructor(
    private signalExtractor: TokenSignalExtractor,
    private hardFilter: HardRuleEngine,
    private ensemble: SpecialistEnsemble,
    private regimeDetector: RegimeDetector,
    private dynamicSizer: DynamicSizer,
    private executionRouter: ExecutionRouter,
    private riskManager: RiskManager,
  ) {}

  async processToken(tokenAddress: string, chain: 'solana' | 'ethereum' | 'polygon' = 'solana'): Promise<void> {
    // 1. Extract signals
    const signalResult = await this.signalExtractor.extractSignals(tokenAddress, chain);
    const signals: SignalVector = signalResult.signals;

    // 2. Hard-rule filter (can short-circuit to reject)
    const filterResult = this.hardFilter.evaluate(signals);
    if (filterResult.shouldRejectImmediately) {
      return; // Reject token early
    }

    // 3. Ensemble scoring
    const ensembleResult = await this.ensemble.predict(signals);

    // 4. Check regime
    const regime = await this.regimeDetector.evaluate();

    // 5. Dynamic sizing (uses ensemble score + regime)
    const positionSize = this.dynamicSizer.computeSize({
      edgeScore: ensembleResult.ensembleScore,
      regime: regime.currentRegime,
      confidence: ensembleResult.confidenceAdjustedScore,
    });

    // 6. Execute
    await this.executionRouter.routeExecution({
      tokenAddress,
      positionSizeSol: positionSize,
      signals,
    });
  }
}
