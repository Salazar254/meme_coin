/**
 * scripts/run-scenarios.ts
 *
 * Executable script: runs all scenario tests and prints the report.
 *
 * Usage:
 *   npx ts-node src/scripts/run-scenarios.ts
 *   npm run scenarios
 */

import { ScenarioTester } from '../engine/scenario-tester';

async function main(): Promise<void> {
  console.log('');
  console.log('🚀 Memecoin Sniper Engine — Scenario Test Suite');
  console.log('================================================');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');

  const tester = new ScenarioTester();
  const startTime = Date.now();

  console.log('Running all 6 scenarios...\n');
  const results = await tester.runAllScenarios();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nAll scenarios completed in ${elapsed}s\n`);

  // Print the full report
  const report = ScenarioTester.formatReport(results);
  console.log(report);

  // Exit code: non-zero if any scenario had negative Sharpe
  let exitCode = 0;
  for (const [key, result] of results) {
    if (result.sharpe < -2) {
      console.error(`⚠ WARNING: Scenario "${key}" has very negative Sharpe (${result.sharpe.toFixed(3)})`);
      exitCode = 1;
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
