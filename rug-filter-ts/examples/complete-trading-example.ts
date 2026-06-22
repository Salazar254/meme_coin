/**
 * examples/complete-trading-example.ts
 *
 * Complete example showing how to use the high-throughput trading engine
 * in a realistic scenario with signal generation, execution simulation, and reporting.
 */

import {
  TradingEngineOrchestrator,
  TradingEngineConfig,
  TokenSignal,
  TradeOutcome,
  SizingBucket,
  MarketRegime,
  ScenarioTester,
  SCENARIOS,
} from '../src/engine';

/**
 * Example 1: Basic usage with event monitoring
 */
async function example1BasicUsage() {
  console.log('\n=== Example 1: Basic Usage ===\n');

  // Create orchestrator
  const engine = new TradingEngineOrchestrator({
    liveExecution: false,  // Simulation mode
    maxTradesPerSecond: 10,
    dailyTargetSol: 5.0,
    verbose: false,
  });

  // Listen to events
  engine.on('decision', (decision) => {
    if (decision.order) {
      console.log(`✓ Order approved: ${decision.signal.mint} @ ${decision.order.sizeSol.toFixed(4)} SOL`);
    }
  });

  engine.on('trade_entry', (position) => {
    console.log(`↗ Entry: ${position.bucket} ${position.mint} ${position.entrySizeSol.toFixed(4)} SOL`);
  });

  engine.on('trade_outcome', (outcome) => {
    console.log(`↘ Exit: PnL ${outcome.pnlSol >= 0 ? '+' : ''}${outcome.pnlSol.toFixed(4)} SOL (${(outcome.pnlPct * 100).toFixed(1)}%)`);
  });

  engine.on('kill_switch', ({ reason }) => {
    console.warn(`⚠️  KILL SWITCH TRIGGERED: ${reason}`);
  });

  // Process 10 sample signals
  for (let i = 0; i < 10; i++) {
    const signal = generateSampleSignal(i, Math.random() < 0.15);  // 15% rug rate
    await engine.processSignal(signal);

    // Simulate trade outcome (after 30s hold)
    if (Math.random() < 0.5) {
      const outcome = generateSampleOutcome(signal, i);
      engine.recordTradeOutcome(outcome);
    }
  }

  // Get stats
  const stats = engine.getStats();
  console.log('\nEngine Stats:', JSON.stringify(stats, null, 2));

  const summary = engine.getDailySummary();
  console.log('\nDaily Summary:', {
    trades: summary.tradesExecuted,
    pnl: `${summary.netPnlSol.toFixed(4)} SOL`,
    winRate: `${(summary.winRate * 100).toFixed(1)}%`,
    sharpe: summary.sharpe.toFixed(3),
  });
}

/**
 * Example 2: Risk management and kill switches
 */
async function example2RiskManagement() {
  console.log('\n=== Example 2: Risk Management & Kill Switches ===\n');

  const engine = new TradingEngineOrchestrator({
    liveExecution: false,
    maxTradesPerSecond: 5,
  });

  engine.on('kill_switch', ({ reason }) => {
    console.warn(`⚠️  KILL SWITCH: ${reason}`);
  });

  // Simulate a string of losses that triggers survival mode
  const riskMgr = engine.getPipeline().riskManager;

  console.log('Initial state:', riskMgr.getStats().riskMode);

  // Simulate consecutive losses
  for (let i = 0; i < 10; i++) {
    const outcome: TradeOutcome = {
      mint: `loss_${i}`,
      entryTimestamp: Date.now() - 1000,
      exitTimestamp: Date.now(),
      entrySizeSol: 0.5,
      pnlSol: -0.25,  // Loss
      pnlPct: -50,
      holdTimeMs: 1000,
      slippageEntry: 0.015,
      slippageExit: 0.015,
      fillQuality: 0.85,
      bucket: SizingBucket.FAST_REACT,
      regime: MarketRegime.NORMAL,
      mlScoreAtEntry: 0.5,
      expectedEdgeAtEntry: 0.01,
    };

    riskMgr.onTradeExit(outcome);
    console.log(
      `Trade ${i + 1}: Risk mode = ${riskMgr.getStats().riskMode}, ` +
      `DD = ${riskMgr.getStats().dailyDrawdownPct.toFixed(2)}%, ` +
      `Losses = ${riskMgr.getState().consecutiveLosses}`,
    );
  }

  // Manual kill switch
  engine.killSwitch('excessive_drawdown_manual');
  console.log('Manual kill switch activated');
  console.log('Kill switch status:', riskMgr.getState().killSwitchTriggered);

  // Resume
  engine.resumeTrading();
  console.log('Trading resumed');
  console.log('Kill switch status:', riskMgr.getState().killSwitchTriggered);
}

/**
 * Example 3: Regime detection and adaptive sizing
 */
async function example3RegimeDetection() {
  console.log('\n=== Example 3: Regime Detection & Adaptive Sizing ===\n');

  const engine = new TradingEngineOrchestrator();
  const detector = engine.getPipeline().regimeDetector;

  console.log('Simulating regime changes...\n');

  // Phase 1: Winning streak (ACCELERATING)
  console.log('Phase 1: Winning streak...');
  for (let i = 0; i < 15; i++) {
    detector.recordOutcome({
      mint: `win_${i}`,
      entryTimestamp: Date.now() - 1000,
      exitTimestamp: Date.now(),
      entrySizeSol: 0.5,
      pnlSol: 0.15,      // Win
      pnlPct: 30,
      holdTimeMs: 1000,
      slippageEntry: 0.01,
      slippageExit: 0.01,
      fillQuality: 0.95,
      bucket: SizingBucket.FAST_REACT,
      regime: MarketRegime.NORMAL,
      mlScoreAtEntry: 0.7,
      expectedEdgeAtEntry: 0.02,
    });
  }

  let regime = detector.detect();
  console.log(`  → Regime: ${regime.regime}, WinRate: ${(regime.recentWinRate * 100).toFixed(0)}%, Sharpe: ${regime.recentSharpe.toFixed(2)}`);

  // Phase 2: Deterioration (FRAGILE)
  console.log('\nPhase 2: Deterioration...');
  for (let i = 0; i < 10; i++) {
    detector.recordOutcome({
      mint: `mixed_${i}`,
      entryTimestamp: Date.now() - 1000,
      exitTimestamp: Date.now(),
      entrySizeSol: 0.5,
      pnlSol: Math.random() < 0.4 ? -0.2 : 0.05,  // Mix of wins/losses
      pnlPct: Math.random() < 0.4 ? -40 : 10,
      holdTimeMs: 1000,
      slippageEntry: 0.02,
      slippageExit: 0.02,
      fillQuality: 0.75,
      bucket: SizingBucket.ULTRA_FAST_SNIPE,
      regime: MarketRegime.NORMAL,
      mlScoreAtEntry: 0.5,
      expectedEdgeAtEntry: 0.01,
    });
  }

  regime = detector.detect();
  console.log(`  → Regime: ${regime.regime}, WinRate: ${(regime.recentWinRate * 100).toFixed(0)}%, Sharpe: ${regime.recentSharpe.toFixed(2)}`);

  // Show multipliers
  const mults = detector.getMultipliers();
  console.log(`  → Multipliers: size=${mults.sizeMultiplier}, risk=${mults.riskMultiplier}`);
}

/**
 * Example 4: Full scenario test
 */
async function example4ScenarioTesting() {
  console.log('\n=== Example 4: Scenario Testing ===\n');

  const tester = new ScenarioTester();

  // Run base case
  console.log('Running BASE_CASE scenario...');
  const baseResult = await tester.runScenario(SCENARIOS.BASE_CASE);
  console.log(`  Trades: ${baseResult.totalTrades}`);
  console.log(`  PnL: ${baseResult.netPnlSol.toFixed(4)} SOL`);
  console.log(`  Sharpe: ${baseResult.sharpe.toFixed(3)}`);
  console.log(`  Max DD: ${baseResult.maxDrawdownPct.toFixed(2)}%`);
  console.log(`  Win Rate: ${(baseResult.winRate * 100).toFixed(1)}%`);

  // Run stress scenario
  console.log('\nRunning STRESS_MARKET scenario...');
  const stressResult = await tester.runScenario(SCENARIOS.STRESS_MARKET);
  console.log(`  Trades: ${stressResult.totalTrades}`);
  console.log(`  PnL: ${stressResult.netPnlSol.toFixed(4)} SOL`);
  console.log(`  Sharpe: ${stressResult.sharpe.toFixed(3)}`);
  console.log(`  Win Rate: ${(stressResult.winRate * 100).toFixed(1)}%`);

  // Run high-throughput
  console.log('\nRunning HIGH_THROUGHPUT_BURST scenario...');
  const burstResult = await tester.runScenario(SCENARIOS.HIGH_THROUGHPUT_BURST);
  console.log(`  Trades: ${burstResult.totalTrades}`);
  console.log(`  Trades/hour: ${burstResult.tradesPerHour.toFixed(0)}`);
  console.log(`  Sharpe: ${burstResult.sharpe.toFixed(3)}`);
}

/**
 * Example 5: Batch signal processing
 */
async function example5BatchProcessing() {
  console.log('\n=== Example 5: Batch Signal Processing ===\n');

  const engine = new TradingEngineOrchestrator({
    liveExecution: false,
    maxTradesPerSecond: 50,  // Higher throughput
  });

  // Generate 100 signals
  console.log('Processing batch of 100 signals...');
  const signals: TokenSignal[] = [];
  for (let i = 0; i < 100; i++) {
    signals.push(generateSampleSignal(i, Math.random() < 0.15));
  }

  const startMs = Date.now();
  await engine.processSignal Batch(signals);
  const elapsedMs = Date.now() - startMs;

  const stats = engine.getStats();
  console.log(`Elapsed: ${elapsedMs}ms`);
  console.log(`Throughput: ${(signals.length / (elapsedMs / 1000)).toFixed(0)} signals/sec`);
  console.log(`Executed: ${stats.totalTradesExecuted} trades`);
  console.log(`Filter pass rate: ${((1 - stats.riskState.openExposurePct / 100) * 100).toFixed(1)}%`);
}

// ─── Utilities ──────────────────────────────────────────────────────

function generateSampleSignal(index: number, isRug: boolean): TokenSignal {
  const liquiditySol = isRug ? 0.1 + Math.random() * 0.9 : 0.5 + Math.random() * 5;
  const uniqueBuyers = isRug ? Math.floor(1 + Math.random() * 3) : Math.floor(5 + Math.random() * 30);

  return {
    mint: `token_${index}_${Math.random().toString(36).substring(2, 8)}`,
    receivedAt: Date.now(),
    liquiditySol,
    liquidityUsd: liquiditySol * 150,
    uniqueBuyers,
    totalVolume: liquiditySol * (0.5 + Math.random() * 5),
    marketCapSol: liquiditySol * (1 + Math.random() * 10),
    timeSinceLaunchSec: Math.random() * 20,
    slippageEstimate: 0.01 + Math.random() * 0.1,
    priceGrowth1s: isRug ? -0.1 + Math.random() * 0.2 : Math.random() * 0.5,
    socialProxy1s: isRug ? Math.random() * 0.3 : 0.2 + Math.random() * 0.6,
    lpGrowth1s: Math.random() * 0.4 - 0.1,
    buyersPerSol: uniqueBuyers / Math.max(liquiditySol, 0.01),
    volumeToLpRatio: (liquiditySol * 5) / liquiditySol,
    logLiquidity: Math.log1p(liquiditySol),
    logVolume: Math.log1p(liquiditySol * 5),
    logMcap: Math.log1p(liquiditySol * 5),
    hourOfDay: new Date().getHours(),
    dayOfWeek: new Date().getDay(),
    isWeekend: new Date().getDay() >= 5,
    mintEnabled: isRug && Math.random() < 0.3,
    isHoneypot: isRug && Math.random() < 0.25,
    isKnownRugDeployer: isRug && Math.random() < 0.15,
    lpLocked: isRug ? Math.random() < 0.2 : Math.random() < 0.8,
    lpBurned: !isRug && Math.random() < 0.3,
    sellTax: isRug ? Math.floor(Math.random() * 30) : Math.floor(Math.random() * 5),
    buyTax: isRug ? Math.floor(Math.random() * 10) : Math.floor(Math.random() * 3),
    ownershipRenounced: isRug ? Math.random() < 0.2 : Math.random() < 0.7,
    top10HolderPct: isRug ? 60 + Math.random() * 30 : 15 + Math.random() * 40,
    devWalletPct: isRug ? 15 + Math.random() * 30 : Math.random() * 10,
    walletClusterScore: isRug ? 0.3 + Math.random() * 0.5 : Math.random() * 0.3,
  };
}

function generateSampleOutcome(signal: TokenSignal, index: number): TradeOutcome {
  const isWin = Math.random() < 0.6;  // 60% win rate
  const pnlPct = isWin ? Math.random() * 0.5 : -(0.1 + Math.random() * 0.5);

  return {
    mint: signal.mint,
    entryTimestamp: Date.now() - 30000,
    exitTimestamp: Date.now(),
    entrySizeSol: 0.5 + Math.random() * 1.5,
    pnlSol: (0.5 + Math.random()) * pnlPct,
    pnlPct,
    holdTimeMs: 20000 + Math.random() * 30000,
    slippageEntry: signal.slippageEstimate * (0.5 + Math.random()),
    slippageExit: signal.slippageEstimate * (0.5 + Math.random()),
    fillQuality: 0.85 + Math.random() * 0.15,
    bucket: [SizingBucket.ULTRA_FAST_SNIPE, SizingBucket.FAST_REACT, SizingBucket.LATE_MOMENTUM][
      Math.floor(Math.random() * 3)
    ],
    regime: MarketRegime.NORMAL,
    mlScoreAtEntry: 0.4 + Math.random() * 0.5,
    expectedEdgeAtEntry: 0.005 + Math.random() * 0.03,
  };
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║   HIGH-THROUGHPUT MEMECOIN SNIPER - USAGE EXAMPLES             ║');
  console.log('║   Production-grade trading engine targeting $1-3M/day           ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  try {
    // Run examples
    await example1BasicUsage();
    await example2RiskManagement();
    await example3RegimeDetection();
    await example4ScenarioTesting();
    await example5BatchProcessing();

    console.log('\n✓ All examples completed successfully!\n');
  } catch (err) {
    console.error('Error:', err);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { example1BasicUsage, example2RiskManagement, example3RegimeDetection, example4ScenarioTesting, example5BatchProcessing };
