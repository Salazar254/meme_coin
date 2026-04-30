/**
 * src/index.ts
 *
 * Main export and initialization
 */

import pino from 'pino';

import { RugFilterOrchestrator } from './orchestrator/rug-filter-orchestrator';
import { RugFilterConfig } from './types';
import { OpportunityRanker } from './components/opportunity-ranker';
import { DynamicSizer } from './engine/dynamic-sizer';
import { ExecutionRouter } from './engine/execution-router';
import { RiskManager } from './engine/risk-manager';

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

// Extend the orchestrator to include the high-throughput pipeline
export class HighThroughputPipeline {
  constructor(
    private tokenSignals: TokenSignalExtractor,
    private hardFilter: HardRuleEngine,
    private opportunityRanker: OpportunityRanker,
    private regimeDetector: RegimeDetector,
    private dynamicSizer: DynamicSizer,
    private executionRouter: ExecutionRouter,
    private riskManager: RiskManager,
  ) {}

  async processToken(token: Token): Promise<void> {
    const signal = await this.tokenSignals.extract(token);
    const filterResult = await this.hardFilter.evaluate(signal);

    if (!filterResult.accepted) {
      return; // Reject token early
    }

    const rankedOpportunities = await this.opportunityRanker.rank(signal);
    const regime = await this.regimeDetector.detect(signal);
    const positionSize = this.dynamicSizer.size(rankedOpportunities, regime);

    await this.executionRouter.execute(token, positionSize);
    this.riskManager.track(token, positionSize);
  }
}
