/**
 * src/scripts/retrain-models.ts
 *
 * CLI script to trigger retraining cycle
 * Usage: npm run retrain
 */

import { createRugFilter } from '../index';
import { RugFilterConfig } from '../types';

async function main() {
  const config: RugFilterConfig = {
    goPlusApiKey: process.env.GOPLUS_API_KEY,
    heliusApiKey: process.env.HELIUS_API_KEY,

    anomalyDetectorModelPath: process.env.ANOMALY_MODEL_PATH || './models/autoencoder.pt',
    contractModelPath: process.env.CONTRACT_MODEL_PATH || './models/contract_model.pkl',
    walletModelPath: process.env.WALLET_MODEL_PATH || './models/wallet_model.pkl',
    liquidityModelPath: process.env.LIQUIDITY_MODEL_PATH || './models/liquidity_model.pkl',
    socialModelPath: process.env.SOCIAL_MODEL_PATH || './models/social_model.pkl',

    pythonRuntimePath: process.env.PYTHON_PATH || 'python',
    pythonModelServerUrl: process.env.PYTHON_SERVER_URL,

    feedbackDbPath: process.env.FEEDBACK_DB_PATH || './feedback.db',

    signalExtractionTimeout: 2000,
    apiCallTimeout: 300,
    maxConcurrentApis: 5,

    anomalyThreshold: 0.7,
    conflictThreshold: 30,

    retrainIntervalDays: 7,
    minFeedbackRecordsForRetrain: parseInt(process.env.MIN_FEEDBACK || '100'),
    ewcFisherPenaltyFactor: parseFloat(process.env.EWC_PENALTY || '0.4'),

    maxDrawdownPct: 35,

    logLevel: 'INFO',
  };

  const rugFilter = createRugFilter(config, 'info');

  console.log('\n🔄 Starting retraining cycle...\n');

  rugFilter.on('retrain', (report) => {
    console.log('\n✅ Retrain cycle complete:');
    console.log(`   Cycle: ${report.retrainCycle}`);
    console.log(`   Training records: ${report.trainingRecords}`);
    console.log(`   Validation records: ${report.validationRecords}`);
    console.log(`   Accuracy before: ${(report.modelAccuracyBefore * 100).toFixed(1)}%`);
    console.log(`   Accuracy after: ${(report.modelAccuracyAfter * 100).toFixed(1)}%`);
    console.log(`   Delta: ${(report.accuracyDelta * 100).toFixed(1)}%`);
    console.log(`   Deployed: ${report.deployed ? '✅ YES' : '❌ NO'}\n`);

    rugFilter.stop();
    process.exit(report.deployed ? 0 : 1);
  });

  try {
    await rugFilter.retrain();
  } catch (err) {
    console.error('\n❌ Retrain error:', err);
    rugFilter.stop();
    process.exit(1);
  }

  // Timeout if retrain takes too long
  setTimeout(() => {
    console.error('\n❌ Retrain timeout');
    rugFilter.stop();
    process.exit(1);
  }, 10 * 60 * 1000); // 10 minutes
}

main().catch(console.error);
