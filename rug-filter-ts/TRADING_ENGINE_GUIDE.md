/**
 * TRADING_ENGINE_GUIDE.md
 *
 * High-Throughput Memecoin Sniper Trading Engine - Complete Usage Guide
 *
 * Target: $1M–$3M/day gross opportunity capture
 * Design: Aggressive scaling with hard risk limits and regime-aware sizing
 */

# High-Throughput Memecoin Sniper Trading Engine

## Overview

The trading engine is a production-grade TypeScript/Node.js system optimized for aggressive memecoin opportunity capture with aggressive throughput while surviving bad regimes.

### Core Components

1. **HardFilter** — Ultra-fast pre-trade screening (<400ms)
   - Rejects tokens with critical issues (mint enabled, honeypot, no LP lock, extreme concentration)
   - Returns score and decision immediately
   - ML cannot override critical rejects

2. **MLOpportunityRanker** — Multi-target ML prediction
   - Predicts: expectedReturn, rugProbability, volatilityEdge, confidence
   - Ranks by: expectedEdge * (1 - rugProbability) * confidence
   - Scores: liquidityQuality, launchFreshness, regimeFit

3. **TradingRegimeDetector** — 4-state market classifier
   - ACCELERATING: high win rate, high Sharpe, strong launches
   - NORMAL: balanced conditions
   - FRAGILE: rising drawdown slope, increasing slippage
   - STRESS: low Sharpe, high fill failures, low win rate
   - Adjusts sizing and risk multipliers dynamically

4. **DynamicSizer** — Intelligent position allocation
   - Base size from equity
   - Scales by: ML confidence, regime multiplier, edge, bucket risk
   - Top-decile boost: 2.5x for highest-conviction trades
   - Drawdown reduction: scales down as equity declines

5. **RiskManager** — Hard risk guardrails
   - Per-trade risk cap, per-token exposure cap, total exposure cap
   - Daily and rolling drawdown limits with kill-switch
   - Automatic survival mode: 50% caps on all limits when Sharpe < -0.2
   - Concurrency limits: max 350 open positions

6. **ExecutionRouter** — Order execution and tracking
   - Priority queue: sorts by expected edge
   - Deadline enforcement: orders expire after 5s
   - Simulates fills, slippage, latency
   - Tracks bucket-level and regime-level performance

7. **FeedbackLoop** — Retraining orchestration
   - Records: token outcome, trade PnL, slippage, fill quality, regime
   - Feeds back to: hard filter weights, ML ranker hints, sizing rules
   - Learning rate: 5% per retrain cycle (max 5pt delta)

## Architecture

```
TokenSignals (500/min+ target)
    ↓
HardFilter [<400ms parallel checks]
    ↓ (pass: 85%, 50-70 tokens/min)
MLOpportunityRanker [multi-target predictions]
    ↓ (top candidates for sizing)
RegimeDetector [4-state classifier]
    ↓
DynamicSizer [bucket-based allocation]
    ↓
RiskManager [hard caps, survival mode]
    ↓
ExecutionRouter [priority queue, <200ms]
    ↓
Active Positions [tracked in risk state]
    ↓ [48h+ later]
Trade Outcomes [recorded for feedback]
    ↓
FeedbackLoop [retrain on every 50-100 outcomes]
    ↓
Retrain Components [hard filter, ML, sizing rules]
```

## Quick Start

```typescript
import { TradingEngineOrchestrator, TokenSignal } from './engine';

// 1. Create orchestrator with configuration
const engine = new TradingEngineOrchestrator({
  liveExecution: false,  // true for live trading
  maxTradesPerSecond: 10,
  dailyTargetSol: 5.0,
  dailyResetHourUtc: 0,
  // Pipeline config passed through
  maxSlippagePct: 0.15,
  orderDeadlineMs: 5000,
});

// 2. Listen to events
engine.on('decision', (decision) => {
  console.log(`Decision: ${decision.signal.mint} → ${decision.stage}`);
});

engine.on('trade_entry', (position) => {
  console.log(`Entry: ${position.mint} ${position.entrySizeSol} SOL in ${position.bucket}`);
});

engine.on('trade_outcome', (outcome) => {
  console.log(`Outcome: ${outcome.mint} ${outcome.pnlSol >= 0 ? '+' : ''}${outcome.pnlSol.toFixed(4)} SOL`);
});

engine.on('kill_switch', ({ reason }) => {
  console.error(`⚠️  KILL SWITCH: ${reason}`);
});

// 3. Process token signals
const signal: TokenSignal = {
  mint: 'token_address',
  receivedAt: Date.now(),
  liquiditySol: 2.5,
  liquidityUsd: 375,
  uniqueBuyers: 20,
  totalVolume: 100,
  marketCapSol: 50,
  timeSinceLaunchSec: 3,
  // ... other fields (full TokenSignal interface)
};

await engine.processSignal(signal);

// 4. Record outcomes (after fills + hold time)
const outcome = {
  mint: 'token_address',
  entryTimestamp: Date.now() - 30000,
  exitTimestamp: Date.now(),
  entrySizeSol: 1.5,
  pnlSol: 0.45,      // +0.45 SOL
  pnlPct: 0.30,      // 30%
  holdTimeMs: 30000,
  slippageEntry: 0.01,
  slippageExit: 0.01,
  fillQuality: 0.95,
  bucket: 'FAST_REACT',
  regime: 'NORMAL',
  mlScoreAtEntry: 0.75,
  expectedEdgeAtEntry: 0.02,
};

engine.recordTradeOutcome(outcome);

// 5. Check stats anytime
const stats = engine.getStats();
console.log(JSON.stringify(stats, null, 2));

// 6. Get daily summary (auto-generated hourly)
const summary = engine.getDailySummary();
console.log(`Today: ${summary.tradesExecuted} trades, ${summary.netPnlSol} SOL PnL`);
```

## Risk Management Modes

### Normal Mode (default)
- Max risk per trade: 0.5% of equity
- Max total exposure: 18% of equity
- Max token exposure: 9% of equity
- Max concurrent trades: 350
- ML score multiplier: 1.0x
- Min ML score floor: 0.0 (no floor)

### Survival Mode (auto-triggered)
- Triggers when: Sharpe < -0.2 OR 8 consecutive losses
- Max risk per trade: 0.25% (50% of normal)
- Max total exposure: 10.8% (60% of normal)
- Max token exposure: 5.4% (60% of normal)
- Max concurrent trades: 210 (60% of normal)
- ML score multiplier: 0.8x
- Min ML score floor: 0.6 (requires 60%+ confidence)
- Auto-recovers when: Sharpe > 0.5 AND <3 consecutive losses

### Regime Adjustments

**ACCELERATING**
- Position size: +40%
- ML threshold: -5% (easier)
- Concurrency: +30%
- Risk: +20%

**NORMAL**
- Position size: 1.0x
- ML threshold: 0%
- Concurrency: 1.0x
- Risk: 1.0x

**FRAGILE**
- Position size: -35% (65% of normal)
- ML threshold: +5% (stricter)
- Concurrency: -30% (70% of normal)
- Risk: -30% (70% of normal)

**STRESS**
- Position size: -65% (35% of normal)
- ML threshold: +12% (much stricter)
- Concurrency: -50% (50% of normal)
- Risk: -60% (40% of normal)

## Position Sizing Buckets

### ULTRA_FAST_SNIPE (age 0–2s)
- Min confidence: 55%
- Risk multiplier: 0.6x
- Max bucket exposure: 4% of equity
- Use case: Respond to brand-new launches with high conviction

### FAST_REACT (age 2–6s)
- Min confidence: 45%
- Risk multiplier: 1.0x
- Max bucket exposure: 6% of equity
- Use case: Early opportunities with decent signals

### LATE_MOMENTUM (age 6–15s)
- Min confidence: 60%
- Risk multiplier: 0.7x
- Max bucket exposure: 4% of equity
- Use case: Established growth patterns

### RECOVERY_MODE (age 0–60s, special)
- Min confidence: 70%
- Risk multiplier: 0.3x
- Max bucket exposure: 2% of equity
- Use case: Very selective trades when drawdown is high

## ML Prediction Outputs

The ML ranker returns:

```typescript
interface MLPrediction {
  expectedReturn: number;          // -1.0 to +2.0 (1-5 min horizon)
  rugProbability: number;          // 0.0 to 1.0
  volatilityAdjustedEdge: number;  // -1.0 to +1.0
  confidence: number;              // 0.0 to 1.0
}
```

**Expected Edge Calculation:**
```
expectedEdge = expectedReturn * (1 - rugProbability) * confidence
```

Example:
- expectedReturn: 0.05 (+5%)
- rugProbability: 0.10 (10% rug risk)
- confidence: 0.80 (80% confident)
- expectedEdge = 0.05 * 0.90 * 0.80 = 0.036 (3.6% edge)

## Scenario Testing

Run comprehensive stress tests:

```typescript
import { ScenarioTester, SCENARIOS } from './engine';

const tester = new ScenarioTester();

// Run single scenario
const baseResult = await tester.runScenario(SCENARIOS.BASE_CASE);
console.log(`Base case: ${baseResult.totalTrades} trades, ${baseResult.sharpe.toFixed(3)} Sharpe`);

// Run all scenarios
const allResults = await tester.runAllScenarios();

// Get formatted report
const report = ScenarioTester.formatReport(allResults);
console.log(report);
```

### Included Scenarios

1. **BASE_CASE** — Normal: 500 tokens, 15% rug rate, 1.0x volatility
2. **NOISY_MARKET** — Bad: 600 tokens, 35% rug rate, 2.0x volatility
3. **REGIME_SHIFT** — Cycles through all 4 regimes
4. **STRESS_MARKET** — Sustained stress: 40% rug rate, 2.5x volatility
5. **HIGH_THROUGHPUT_BURST** — 2000 tokens, 60 launches/min (throughput test)
6. **PARAMETER_SWEEP** — Mixed conditions for sensitivity analysis

## Performance Targets

### Latency (p95)
- Hard filter: <400ms
- ML prediction: <500ms
- Risk assessment: <100ms
- Execution: <200ms
- **Total pipeline: <1.5s**

### Throughput
- Signals: 500–1000/min target
- Executed trades: 100–300/min target
- Daily trades: ~5000–15000 (assuming 8h active)
- Daily opportunities: $1M–$3M gross

### Performance
- Target Sharpe: 0.6–1.2
- Target max drawdown: 30–35%
- Target win rate: 55–65%
- Target fill rate: >85%

## Integration with Python ML Models

For production, the engine integrates with Python ML models via HTTP bridge:

```bash
# Start Python model server
python ml/model_server.py --port 5000

# Engine automatically calls http://localhost:5000/predict
# Fallback: uses lightweight TypeScript heuristics if server unavailable
```

Python model expected interface:
```python
POST /predict
{
  "features": [18 numbers],  # Normalized token signal features
  "feature_names": ["liquiditySol", "uniqueBuyers", ...]
}

Response:
{
  "expectedReturn": 0.05,
  "rugProbability": 0.1,
  "volatilityEdge": 0.04,
  "confidence": 0.8
}
```

## Kill Switches and Manual Controls

```typescript
// Trigger kill switch
engine.killSwitch("manual_stop_requested");

// Resume trading
engine.resumeTrading();

// Force risk mode
engine.setRiskMode("SURVIVAL");
engine.setRiskMode("NORMAL");

// Check current state
const state = engine.getPipeline().riskManager.getState();
console.log(`Killed: ${state.killSwitchTriggered}`);
console.log(`Mode: ${state.riskMode}`);
```

## Monitoring and Observability

```typescript
// Real-time stats
const stats = engine.getStats();
console.log(`Active: ${stats.activeTrades}`);
console.log(`Daily PnL: ${stats.dailyNetPnl.toFixed(4)} SOL`);
console.log(`Risk Mode: ${stats.riskState.riskMode}`);
console.log(`Regime: ${stats.regimeState.regime}`);

// Daily summary (auto-generated at reset hour)
const summary = engine.getDailySummary();
console.log(`Trades: ${summary.tradesExecuted}`);
console.log(`Win Rate: ${(summary.winRate * 100).toFixed(1)}%`);
console.log(`Sharpe: ${summary.sharpe.toFixed(3)}`);
console.log(`Max DD: ${summary.maxDrawdownPct.toFixed(2)}%`);
```

## Production Deployment

1. **Initialize engine** with configuration
2. **Start signal ingestion** from token API
3. **Listen to events** and log decisions
4. **Record outcomes** 48h+ after entry
5. **Monitor stats** in real-time dashboard
6. **Set kill switches** on excessive drawdown
7. **Retrain weekly** with feedback loop
8. **Rotate daily** at reset hour for fresh stats

## Example: Complete Trading Loop

```typescript
import { TradingEngineOrchestrator } from './engine';

async function main() {
  const engine = new TradingEngineOrchestrator({
    liveExecution: false,  // Set to true for live
    maxTradesPerSecond: 5,
    dailyTargetSol: 5.0,
  });

  // Simulate signal stream
  for (let i = 0; i < 100; i++) {
    const signal = generateRandomSignal(i);  // Your signal source
    
    try {
      const decision = await engine.processSignal(signal);
      
      if (decision.order) {
        console.log(`✓ Order: ${decision.signal.mint} ${decision.order.sizeSol} SOL`);
        
        // Simulate execution and outcome (replace with real broker)
        await simulateTradeExecution(decision, engine);
      }
    } catch (err) {
      console.error(`Error processing ${signal.mint}:`, err.message);
    }
  }

  // Get final report
  const summary = engine.getDailySummary();
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(console.error);
```

## Key Metrics to Track

- **Daily Trades**: Should see 100–300 executed trades
- **Win Rate**: 55–65% in normal conditions
- **Sharpe Ratio**: Target 0.6–1.2
- **Max Drawdown**: Should stay within 30–35% bounds
- **Fill Rate**: >85% of attempted orders
- **Average Latency**: <1.5s per signal
- **Survival Uptime**: Should survive sustained bad regimes without shutting down

---

For more details, see:
- `ARCHITECTURE.md` — System design and internals
- `INTEGRATION.md` — Integration with existing bot
- Test files: `src/engine/__tests__/integration.test.ts`
