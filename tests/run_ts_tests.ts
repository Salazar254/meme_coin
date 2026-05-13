import { runBacktestHonestyTests } from "./backtest_honesty.test.ts";
import { runRiskManagerTests } from "./risk_manager.test.ts";
import { runMlSkewTests } from "./ml_skew.test.ts";
import { runMemeAlphaTests } from "./meme_alpha.test.ts";

const tests: Array<[string, () => void | Promise<void>]> = [
  ["backtest_honesty", runBacktestHonestyTests],
  ["risk_manager", runRiskManagerTests],
  ["ml_skew", runMlSkewTests],
  ["meme_alpha", runMemeAlphaTests]
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    process.stdout.write(`ok ${name}\n`);
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.stack || error.message : String(error);
    process.stderr.write(`not ok ${name}\n${message}\n`);
  }
}

if (failed > 0) {
  process.exitCode = 1;
}
