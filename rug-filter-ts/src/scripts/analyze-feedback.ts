/**
 * src/scripts/analyze-feedback.ts
 *
 * Analyze feedback statistics and model performance
 * Usage: npm run analyze-feedback
 */

import Database from 'better-sqlite3';
import { FeedbackLogger } from '../persistence/feedback-logger';
import pino from 'pino';

async function main() {
  const dbPath = process.env.FEEDBACK_DB_PATH || './feedback.db';
  const logger = pino();

  const feedbackLogger = new FeedbackLogger(dbPath, logger);

  const stats = feedbackLogger.getStatistics ? feedbackLogger.getStatistics() : {
    totalDecisions: 0,
    labeledDecisions: 0,
    unlabeledDecisions: 0,
    avgRewardSignal: 0,
    outcomeCounts: {},
  };

  console.log('\n📊 FEEDBACK ANALYSIS\n');
  console.log(`Total Decisions:     ${stats.totalDecisions}`);
  console.log(`Labeled Decisions:   ${stats.labeledDecisions}`);
  console.log(`Unlabeled Decisions: ${stats.unlabeledDecisions}`);
  console.log(`Avg Reward Signal:   ${stats.avgRewardSignal.toFixed(3)}\n`);

  console.log('📈 OUTCOME BREAKDOWN:\n');
  Object.entries(stats.outcomeCounts).forEach(([outcome, count]) => {
    const pct = ((count / stats.labeledDecisions) * 100).toFixed(1);
    console.log(`   ${outcome.padEnd(15)}: ${count.toString().padStart(5)} (${pct}%)`);
  });

  // Compute accuracy for BUY decisions
  const db = new Database(dbPath, { readonly: true });
  try {
    const buyCorrectStmt = db.prepare(`
      SELECT COUNT(*) as cnt FROM feedback_records
      WHERE labeled = 1
      AND decision_str = 'BUY'
      AND outcome IN ('STABLE', 'MOONSHOT')
    `);
    const buyCorrect = (buyCorrectStmt.get() as any)?.cnt || 0;

    const buyTotalStmt = db.prepare(`
      SELECT COUNT(*) as cnt FROM feedback_records
      WHERE labeled = 1 AND decision_str = 'BUY'
    `);
    const buyTotal = (buyTotalStmt.get() as any)?.cnt || 0;

    const buyAccuracy = buyTotal > 0 ? (buyCorrect / buyTotal) * 100 : 0;

    console.log(`\n🎯 BUY DECISION ACCURACY: ${buyAccuracy.toFixed(1)}%`);
    console.log(`   Correct: ${buyCorrect}/${buyTotal}\n`);
  } finally {
    db.close();
  }

  feedbackLogger.close();
}

main().catch(console.error);
