import { loadConfig } from "./config.ts";
import { createLogger } from "./utils/logger.ts";
import { TokenRiskScorer, type TokenLaunchEvent } from "./token_risk_scorer.ts";
import { SniperEngine } from "./sniper_engine.ts";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sampleEvent = (): TokenLaunchEvent => ({
  mint: "So11111111111111111111111111111111111111112",
  deployer: "paper_deployer",
  timestamp: Date.now(),
  liquiditySol: 12,
  lpBurnPct: 0.98,
  ageSeconds: 2.2,
  uniqueBuyers: 28,
  totalVolumeSol: 18,
  marketCapSol: 180,
  rugPullRisk: 0.025,
  honeypotRisk: 0.01,
  transferTaxPct: 0.01,
  topHolderPct: 0.11,
  devHoldPct: 0.025,
  mutableMetadata: false,
  mintAuthorityRenounced: true,
  freezeAuthorityRenounced: true,
  volatility1m: 0.28,
  priceVelocity1m: 0.18,
  buySellRatio: 1.35,
  jitoCompetition: 0.45,
  launchRatePerMinute: 420,
  predictedWinProb: 0.58,
  rewardRiskRatio: 1.45,
  futureReturnPct: 0.012,
  synthetic: true
});

export const main = async (): Promise<void> => {
  await loadEnv();
  const command = process.argv[2] || "paper";
  if (command === "stress") {
    const module = await import("../run_stress_test.ts");
    await module.main();
    return;
  }

  const config = loadConfig({
    ...process.env,
    BOT_MODE: command === "live" ? "live" : process.env.BOT_MODE || "paper"
  });
  const logger = createLogger(config.logLevel, { service: "meme-coin-bot" });
  const scorer = await TokenRiskScorer.load(config.scorer.modelPath, config.scorer, logger);
  const engine = new SniperEngine(config, scorer, logger);
  await engine.start();

  if (config.mode === "paper") {
    engine.submit(sampleEvent());
    await engine.drain();
    await engine.stop();
    return;
  }

  logger.info({
    mode: config.mode,
    streams: config.throughput.streamFanout,
    targetEventsPerHour: config.throughput.targetEventsPerHour
  }, "live_engine_ready_for_stream_adapter");
};

const loadEnv = async (): Promise<void> => {
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ quiet: true });
  } catch {
    return;
  }
};

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";

if (import.meta.url === entryUrl) {
  main().catch((error) => {
    const logger = createLogger("error", { service: "meme-coin-bot" });
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "fatal");
    process.exitCode = 1;
  });
}
