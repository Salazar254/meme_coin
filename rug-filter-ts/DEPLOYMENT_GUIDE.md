/**
 * DEPLOYMENT_GUIDE.md
 *
 * Step-by-step guide to deploy and operate the high-throughput memecoin sniper engine
 */

# High-Throughput Memecoin Sniper - Deployment Guide

## Pre-Deployment Checklist

- [ ] TypeScript compiler installed (`npm install`)
- [ ] Tests passing (`npm test`)
- [ ] Scenarios run successfully (`npm run scenarios`)
- [ ] Python 3.8+ available for ML bridge
- [ ] Capital allocation decided (initial bankroll)
- [ ] Risk profile chosen (Normal vs Survival mode thresholds)
- [ ] Token signal source identified
- [ ] DEX/broker integration planned
- [ ] Monitoring dashboard ready
- [ ] Backup/failover plan documented

## Phase 1: Setup & Configuration

### 1.1 Build the Engine

```bash
cd rug-filter-ts
npm install
npm run build
```

### 1.2 Configure Risk Parameters

Edit engine initialization:

```typescript
// src/main.ts or your entry point
const engine = new TradingEngineOrchestrator({
  liveExecution: true,           // Live trading
  maxTradesPerSecond: 10,        // Tune for broker limits
  dailyTargetSol: 5.0,           // Adjust to capital
  dailyResetHourUtc: 0,          // UTC midnight
  
  // Pipeline configs (override defaults if needed)
  riskManager: {
    maxRiskPerTradePct: 0.5,     // 0.5% per trade
    maxTokenExposurePct: 9.0,    // 9% per token
    maxTotalExposurePct: 18.0,   // 18% total
    maxConcurrentTrades: 350,    // Max open positions
    dailyDrawdownLimitPct: 35.0, // Kill-switch threshold
    initialBankrollSol: 100.0,   // Starting capital
  },
  
  dynamicSizer: {
    topDecileMultiplier: 2.5,    // 2.5x for top opportunities
    drawdownScaleFullPct: 25.0,  // Scale at 25% DD
  },
});
```

### 1.3 Setup Python ML Bridge (Optional)

If using trained ML models:

```bash
# Install dependencies
pip install flask torch xgboost numpy joblib

# Start model server
python ml/model_server.py --port 5000

# Verify health
curl http://localhost:5000/health
```

If not available, engine falls back to TypeScript heuristics automatically.

### 1.4 Setup Monitoring & Logging

```typescript
// Listen to engine events
engine.on('decision', (decision) => {
  logger.debug({ mint: decision.signal.mint, stage: decision.stage });
});

engine.on('trade_entry', (position) => {
  logger.info({ 
    event: 'trade_entry',
    mint: position.mint,
    size: position.entrySizeSol,
    bucket: position.bucket,
  });
});

engine.on('trade_outcome', (outcome) => {
  logger.info({
    event: 'trade_outcome',
    mint: outcome.mint,
    pnl: outcome.pnlSol,
    pnlPct: outcome.pnlPct,
  });
});

engine.on('kill_switch', ({ reason }) => {
  logger.error({ event: 'kill_switch', reason });
  // Send alert to monitoring system
});

engine.on('daily_summary', (summary) => {
  logger.info({ event: 'daily_summary', summary });
  // Record to database for tracking
});
```

## Phase 2: Integration

### 2.1 Connect Token Signal Source

```typescript
// Your signal ingestion
async function ingestTokenSignals() {
  const signals = await tokenApiClient.getLatestLaunches();
  
  for (const signal of signals) {
    try {
      const decision = await engine.processSignal(signal);
      
      if (decision.order && decision.risk.approved) {
        // Execute trade
        const fillResult = await broker.buyToken(
          signal.mint,
          decision.order.sizeSol,
        );
        
        if (fillResult.filled) {
          // Track in engine
          engine.recordTradeEntry({
            mint: signal.mint,
            bucket: decision.sizing.bucket,
            entrySizeSol: fillResult.fillSize,
            entryTimestamp: Date.now(),
            mlScore: decision.prediction.confidence,
            regime: decision.regime.regime,
          });
        }
      }
    } catch (err) {
      logger.error({ err, mint: signal.mint }, 'Signal processing failed');
    }
  }
}

// Run ingestion loop
setInterval(ingestTokenSignals, 1000);  // Every second
```

### 2.2 Connect Position Exit Handler

```typescript
// After position closes (48h+, or manual exit)
async function onPositionExit(mint: string, exitPrice: number, exitSize: number) {
  const position = getActivePosition(mint);
  
  if (position) {
    const outcome: TradeOutcome = {
      mint,
      entryTimestamp: position.entryTimestamp,
      exitTimestamp: Date.now(),
      entrySizeSol: position.entrySizeSol,
      pnlSol: (exitPrice - position.entryPrice) * exitSize,
      pnlPct: (exitPrice - position.entryPrice) / position.entryPrice,
      holdTimeMs: Date.now() - position.entryTimestamp,
      slippageEntry: position.slippageEntry,
      slippageExit: calculateSlippage(exitPrice),
      fillQuality: calculateFillQuality(),
      bucket: position.bucket,
      regime: position.regime,
      mlScoreAtEntry: position.mlScore,
      expectedEdgeAtEntry: position.expectedEdge,
    };
    
    engine.recordTradeOutcome(outcome);
  }
}
```

### 2.3 Connect Broker/DEX

```typescript
// Implement broker interface
interface Broker {
  buyToken(mint: string, sizeSol: number): Promise<ExecutionResult>;
  sellToken(mint: string, sizeSol: number): Promise<ExecutionResult>;
  getBalance(mint?: string): Promise<number>;
  getOpenPositions(): Promise<Position[]>;
}

// Example: Solana DEX integration
class RaydiumBroker implements Broker {
  async buyToken(mint: string, sizeSol: number): Promise<ExecutionResult> {
    // 1. Build swap instruction
    // 2. Add to Solana transaction
    // 3. Execute with slippage protection
    // 4. Return { filled: boolean, fillSize, slippage, latency, txHash }
  }
  
  async sellToken(mint: string, sizeSol: number): Promise<ExecutionResult> {
    // Similar to buyToken
  }
}
```

## Phase 3: Operational

### 3.1 Daily Operations

**Morning (start of trading window)**:
```bash
# Verify engine is running
curl http://localhost:9000/health

# Check overnight stats
tail -f logs/engine.log | grep "daily_summary"

# Monitor active positions
./scripts/check-positions.sh
```

**During trading**:
- Monitor throughput: `logs/engine.log | grep "signals_per_hour"`
- Watch drawdown: `curl http://localhost:9000/stats | jq '.riskState.dailyDrawdownPct'`
- Track win rate: `logs/engine.log | grep "win_rate"`
- Check regime: `curl http://localhost:9000/stats | jq '.regimeState.regime'`

**Afternoon (market slowdown)**:
- Analyze trade outcomes
- Check if survival mode triggered
- Decide if adjustments needed

**End of day**:
- Review daily summary
- Record PnL and metrics
- Plan for next day

### 3.2 Risk Management During Trading

**If Sharpe drops < -0.2 or 8 consecutive losses**:
- Survival mode auto-triggers
- All position sizes reduced to 50%
- ML confidence floor raised to 60%
- Automatic recovery when conditions improve

**If daily drawdown > 35%**:
- Kill-switch automatically triggers
- All new trades rejected
- Existing positions allowed to close normally
- Manual review required to resume

**Manual Intervention**:
```typescript
// Check current risk state
const state = engine.getPipeline().riskManager.getState();
console.log({
  mode: state.riskMode,
  killed: state.killSwitchTriggered,
  drawdown: state.dailyDrawdownPct,
  openTrades: state.openPositions.length,
  losses: state.consecutiveLosses,
});

// Trigger kill switch if needed
engine.killSwitch('manual_market_pause');

// Force survival mode
engine.setRiskMode('SURVIVAL');

// Resume after reviewing
engine.resumeTrading();
engine.setRiskMode('NORMAL');
```

### 3.3 Performance Monitoring

Track these metrics daily:

```typescript
const summary = engine.getDailySummary();

const metrics = {
  // Volume
  tradesExecuted: summary.tradesExecuted,
  signalsProcessed: summary.totalSignals,
  filterPassRate: 1 - (summary.hardFilterRejects / summary.totalSignals),
  
  // Returns
  grossPnlSol: summary.grossPnlSol,
  netPnlSol: summary.netPnlSol,
  grossPnlUsd: summary.grossPnlUsd,
  netPnlUsd: summary.netPnlUsd,
  
  // Risk
  sharpe: summary.sharpe,
  maxDrawdown: summary.maxDrawdownPct,
  winRate: summary.winRate,
  
  // Execution
  avgLatency: summary.avgLatencyMs,
  riskMode: summary.riskMode,
  
  // Status
  throughputPerHour: summary.throughputPerHour,
  killSwitchEvents: summary.killSwitchEvents,
};

// Store metrics
await metricsDb.insert(metrics);
```

**Weekly Review**:
- Compare to targets (0.6–1.2 Sharpe, 30–35% max DD)
- Identify problem regimes or setups
- Adjust if needed (see Phase 4)
- Plan retraining if feedback accumulates

## Phase 4: Optimization & Adjustment

### 4.1 Scenario Analysis

When performance deviates from targets:

```bash
npm run scenarios
```

Compare results to production performance:
- Which scenario matches current market?
- How is engine performing in that scenario?
- What adjustments improved scenario results?

### 4.2 Risk Cap Adjustment

Based on performance:

**If drawdown > 35%**:
- Reduce `maxRiskPerTradePct` (e.g., 0.5% → 0.3%)
- Reduce `maxTotalExposurePct` (e.g., 18% → 12%)
- Increase `dailyDrawdownLimitPct` kill-switch threshold

**If not capturing enough volume**:
- Increase `maxConcurrentTrades` (e.g., 350 → 400)
- Increase `topDecileMultiplier` (e.g., 2.5 → 3.0)
- Lower ML score threshold in DynamicSizer

**If win rate < 55%**:
- Increase ML confidence floor (e.g., 30% → 40%)
- Adjust hard filter weights
- Tighten regime-specific thresholds

### 4.3 Model Retraining

Every week or 1000+ outcomes:

```typescript
// Collect feedback
const feedback = await feedbackDb.query({
  after: lastRetrainDate,
  limit: 1000,
});

// Analyze performance
const analysis = analyzePerformance(feedback);
console.log({
  totalOutcomes: feedback.length,
  accuracy: analysis.accuracy,
  byRegime: analysis.regimeBreakdown,
  bySetup: analysis.setupBreakdown,
});

// Retrain models (call Python retraining pipeline)
if (analysis.accuracy < 0.55) {
  await retrainPythonModels(feedback);
  // Restart model server
  await killServer();
  await startServer();
}
```

## Phase 5: Scaling

### 5.1 Increase Capital Allocation

With proven performance (2–4 weeks of positive Sharpe):

```typescript
// Gradually increase daily target
targets = [
  { week: 1, targetSol: 5.0, riskProfile: 'NORMAL' },
  { week: 2, targetSol: 7.5, riskProfile: 'NORMAL' },
  { week: 3, targetSol: 10.0, riskProfile: 'NORMAL' },
  { week: 4, targetSol: 15.0, riskProfile: 'NORMAL' },
];

// Adjust max position and exposure
const scale = dailyTarget / initialTarget;
config.riskManager.maxPositionSol *= scale;
config.riskManager.maxTotalExposurePct *= scale;
```

### 5.2 Increase Throughput

With stable execution:

```typescript
// Gradually increase trades per second
const throughputSchedule = [
  { week: 1, maxTPS: 10, concurrency: 350 },
  { week: 2, maxTPS: 15, concurrency: 400 },
  { week: 3, maxTPS: 20, concurrency: 500 },
  { week: 4, maxTPS: 30, concurrency: 600 },
];

engine.config.maxTradesPerSecond = throughputPerWeek;
engine.getPipeline().riskManager.config.maxConcurrentTrades = concurrencyPerWeek;
```

## Troubleshooting

### Issue: High Latency (>1.5s p95)

**Diagnosis**:
```bash
grep "latencyMs" logs/engine.log | tail -100 | sort -n | tail -20  # p95
```

**Solutions**:
1. If ML latency high: stop Python server, use TypeScript heuristic
2. If filter latency high: reduce parallel API calls (check GoPlus timeout)
3. If risk check high: shouldn't happen, but check open positions count
4. If execution high: increase executor concurrency (max 20)

### Issue: Kill Switch Triggered (DD > 35%)

**Immediate**:
```typescript
// Check what happened
const state = engine.getPipeline().riskManager.getState();
console.log({
  lastOutcomes: state.dailyPnls.slice(-10),  // Last 10 trades
  losingSeries: findConsecutiveLosses(),
  currentRegime: engine.getPipeline().regimeDetector.getCurrentRegime(),
});

// Review recent signals
const badTrades = feedbackDb.query({
  after: Date.now() - 60 * 60 * 1000,  // Last hour
  pnlSol: { $lt: -0.1 },  // Losses > 0.1 SOL
});
```

**Recovery**:
1. Analyze regime (may be STRESS → reduce size)
2. Check ML predictions (calibration drift?)
3. Review filter weights (outdated?)`
4. Consider pausing and manually resuming after analysis

### Issue: Survival Mode Won't Exit

**Check**:
```typescript
const stats = engine.getPipeline().riskManager.getStats();
console.log({
  sharpe: stats.rollingSharpe,
  losses: stats.consecutiveLosses,
  recovery: stats.rollingSharpe > 0.5 && stats.consecutiveLosses < 3,
});
```

**Fix**:
- If Sharpe negative: market is bad, survival mode is correct
- If stuck: manually set mode back to NORMAL once confident
- If repeated: lower survival trigger threshold (Sharpe -0.3 instead of -0.2)

## Maintenance Schedule

### Daily
- [ ] Check overnight stats
- [ ] Monitor active positions
- [ ] Verify no errors in logs
- [ ] Check kill-switch status

### Weekly
- [ ] Review daily summaries
- [ ] Analyze performance vs targets
- [ ] Check regime distribution
- [ ] Rebalance if needed
- [ ] Consider model retraining

### Monthly
- [ ] Full scenario analysis
- [ ] Performance review
- [ ] Risk adjustment if needed
- [ ] Capital reallocation if warranted
- [ ] Update documentation

### Quarterly
- [ ] Deep analysis of all regimes
- [ ] Identify patterns and improvements
- [ ] Plan next quarter adjustments
- [ ] Retrain models with 3m of feedback

## Emergency Procedures

### Market Crash / Extreme Conditions

```typescript
// 1. Immediately disable new trades
engine.killSwitch('MARKET_EMERGENCY');

// 2. Let existing positions close naturally
// (don't force liquidate = more slippage)

// 3. Review positions daily
// 4. Resume only after market stabilizes
// 5. Manual mode if extended crash
```

### System Failure / Lost Connectivity

```typescript
// Ensure position state persisted to database
// On restart:
// 1. Load positions from DB
// 2. Verify against broker
// 3. Resume engine with same positions
// 4. Continue trading

// If position mismatch:
// 1. Manual intervention
// 2. Reconcile broker vs engine state
// 3. Resume carefully
```

### Broker Integration Failure

```typescript
// If broker down for >30 mins:
// 1. Stop engine
// 2. Let existing positions close
// 3. Switch to backup broker or manual mode
// 4. Verify all positions after reconnect
```

## Support & Debugging

**Enable verbose logging**:
```typescript
const engine = new TradingEngineOrchestrator({
  verbose: true,  // Detailed logs
});
```

**Generate debug report**:
```typescript
const debug = {
  config: engine.getPipeline().config,
  stats: engine.getStats(),
  riskState: engine.getPipeline().riskManager.getState(),
  regimeHistory: engine.getPipeline().regimeDetector.getRegimeHistory(),
  recentDecisions: getRecentDecisions(),  // Last 100
};

console.log(JSON.stringify(debug, null, 2));
```

**See also**:
- TRADING_ENGINE_GUIDE.md - Feature documentation
- ARCHITECTURE.md - System design
- examples/ - Code examples

---

**Ready for production deployment of $1M–$3M/day opportunity capture.**
