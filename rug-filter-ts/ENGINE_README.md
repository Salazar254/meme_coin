# High-Throughput Memecoin Sniper Trading Engine

A production-grade TypeScript/Node.js trading system optimized for aggressive memecoin opportunity capture at scale. Designed to safely capture **$1M–$3M/day gross opportunity** while maintaining 0.6–1.2 Sharpe and surviving bad market regimes.

## Features

### Core Architecture
- **7-Stage Pipeline**: Hard filter → ML ranker → Regime detector → Dynamic sizer → Risk manager → Execution router → Feedback loop
- **<1.5s Total Latency** (p95) for signal-to-execution
- **500–1,000 signals/min throughput** (100–300 executed trades/min)
- **4-State Regime Detector**: ACCELERATING, NORMAL, FRAGILE, STRESS with dynamic multipliers
- **Multi-Target ML Predictions**: expectedReturn, rugProbability, volatilityEdge, confidence

### Risk Management
- **Hard Reject Flags**: Mint enabled, honeypot, known rug deployer → never execute
- **Cascading Risk Caps**: Per-trade, per-token, total exposure limits
- **Kill-Switches**: Daily 35% drawdown limit, manual override, auto-recovery
- **Survival Mode**: Auto-triggered when Sharpe < -0.2 or 8 consecutive losses (50% cap reduction)
- **Concurrency Limits**: 350 concurrent trades (normal), 210 (survival)

### Adaptive Sizing
- **Bucket-Based**: ULTRA_FAST (0-2s), FAST_REACT (2-6s), LATE_MOMENTUM (6-15s), RECOVERY (special)
- **Top-Decile Boost**: 2.5x size for top 10% opportunities
- **Confidence Scaling**: 0.5x to 1.5x based on ML confidence
- **Drawdown Scaling**: Shrink to 15% when drawdown exceeds 25%
- **Regime Multipliers**: +40% in ACCELERATING, -65% in STRESS

### Scenario Testing
- **6 Built-In Scenarios**: Base case, noisy market, regime shift, stress, high-throughput burst, parameter sweep
- **Performance Metrics**: Trades, throughput, PnL, Sharpe, max drawdown, win rate, fill rate, latency
- **Aggregate Reporting**: Cross-scenario statistics and performance breakdown

## Quick Start

### Installation

```bash
cd rug-filter-ts
npm install
npm run build
```

### Basic Usage

```typescript
import { TradingEngineOrchestrator, TokenSignal } from './src/engine';

// Create engine
const engine = new TradingEngineOrchestrator({
  liveExecution: false,  // Set true for live trading
  maxTradesPerSecond: 10,
  dailyTargetSol: 5.0,
});

// Listen to events
engine.on('trade_entry', (position) => {
  console.log(`Entry: ${position.mint} ${position.entrySizeSol} SOL`);
});

engine.on('trade_outcome', (outcome) => {
  console.log(`Exit: ${outcome.mint} PnL ${outcome.pnlSol.toFixed(4)} SOL`);
});

// Process signal
const signal: TokenSignal = {
  mint: 'token_address',
  receivedAt: Date.now(),
  liquiditySol: 2.5,
  liquidityUsd: 375,
  // ... other fields
};

await engine.processSignal(signal);

// Record outcome (after trade closes)
engine.recordTradeOutcome(outcome);

// Get stats
const stats = engine.getStats();
console.log(stats);
```

### Run Scenarios

```bash
npm run scenarios
```

Generates performance report across all 6 scenarios with Sharpe, max drawdown, win rate, etc.

### Run Tests

```bash
npm test
```

Comprehensive integration tests for all components.

## Architecture

```
TokenSignals (500-1000/min)
    ↓
[HardFilter] <400ms parallel checks
    ↓ (pass: 50-70%)
[MLOpportunityRanker] multi-target predictions
    ↓
[TradingRegimeDetector] 4-state classifier
    ↓
[DynamicSizer] bucket-based allocation
    ↓
[RiskManager] hard caps + survival mode
    ↓
[ExecutionRouter] priority queue + deadline enforcement
    ↓ (execute: ~200ms)
Live Trades (100-300/min executed)
    ↓ (48h later)
[FeedbackLoop] record outcomes + retrain
```

## Components

### HardFilter
Ultra-fast screening with non-overridable safety rules:
- Rejects: mint enabled, honeypot, known rug deployer, no LP lock, extreme seller concentration
- Returns: score (0–100), reasons, criticality flag
- Latency: <400ms guaranteed

### MLOpportunityRanker
Multi-target ML predictions for ranking:
- Outputs: expectedReturn (-1 to +2), rugProbability (0–1), confidence (0–1)
- Edge formula: expectedReturn × (1 - rugProbability) × confidence
- Sub-scores: liquidityQuality, launchFreshness, regimeFit
- Supports Python model server + TypeScript heuristic fallback

### TradingRegimeDetector
Market regime classification:
- ACCELERATING: high win rate, high Sharpe → +40% size multiplier
- NORMAL: balanced conditions → 1.0x multiplier
- FRAGILE: rising drawdown, slippage → -35% size multiplier  
- STRESS: low Sharpe, failed fills → -65% size multiplier

### DynamicSizer
Intelligent position sizing:
- Base: equity × 0.3% × confidence × regime × edge
- Top-decile boost: 2.5x for top 10% opportunities
- Drawdown reduction: scales to 15% at 25% DD
- Bucket constraints: age-based risk allocation

### RiskManager
Production risk guardrails:
- Per-trade: 0.5% (normal), 0.25% (survival)
- Per-token: 9% (normal), 5.4% (survival)
- Total: 18% (normal), 10.8% (survival)
- Daily DD kill-switch: 35% threshold
- Auto survival mode trigger + manual controls

### ExecutionRouter
Order execution with performance tracking:
- Priority queue: sort by expected edge
- Deadline enforcement: 5s order timeout
- Concurrent execution: max 10 parallel
- Stats: per-bucket and per-regime fill rates

### FeedbackLoop
Retraining orchestration:
- Records: outcome, slippage, fill quality, regime context
- Triggers retraining every 50–100 outcomes
- Adjusts: hard filter weights, ML hints, sizing rules
- Learning rate: 5% per cycle with 5-point delta cap

## Configuration

```typescript
interface TradingEngineConfig {
  // Engine settings
  liveExecution: boolean;        // true = live, false = simulation
  maxTradesPerSecond: number;    // Throughput limit
  dailyTargetSol: number;        // Reporting target
  dailyResetHourUtc: number;     // Daily stats reset hour
  
  // Pipeline settings (passed through)
  maxSlippagePct: number;        // Default 0.15 (15%)
  orderDeadlineMs: number;       // Default 5000 (5s)
  verbose: boolean;              // Default false
}
```

Override any component configs:
```typescript
const engine = new TradingEngineOrchestrator({
  liveExecution: false,
  riskManager?: { maxConcurrentTrades: 500 },  // Override risk caps
  dynamicSizer?: { topDecileMultiplier: 3.0 }, // More aggressive
});
```

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Filter latency | <400ms | Parallel API checks |
| ML latency | <500ms | Python server or heuristic |
| Total latency | <1.5s p95 | End-to-end signal processing |
| Signals/min | 500–1000 | Throughput capacity |
| Executed trades/min | 100–300 | After filtering & risk caps |
| Daily trades | 5K–15K | 8-hour active window |
| Sharpe | 0.6–1.2 | Risk-adjusted return |
| Max drawdown | 30–35% | Safe bounds |
| Win rate | 55–65% | Profitable on balance |
| Fill rate | >85% | Execution quality |

## Risk Profiles

### Normal Mode (Default)
- Aggressive opportunity capture
- Max risk: 0.5% per trade
- Max total exposure: 18%
- Concurrency: 350 trades
- Use when: winning, low drawdown, decent regime

### Survival Mode (Auto-Triggered)
- Conservative risk management
- Max risk: 0.25% per trade (50% reduction)
- Max total exposure: 10.8% (60% reduction)
- Concurrency: 210 trades (60% reduction)
- ML confidence floor: 0.6 (only take high-confidence trades)
- Trigger: Sharpe < -0.2 OR 8 consecutive losses
- Recovery: Sharpe > 0.5 AND <3 consecutive losses

## Monitoring & Events

```typescript
engine.on('decision', (decision) => {
  // All signals, including rejections
});

engine.on('trade_entry', (position) => {
  // Position opened (order executed)
});

engine.on('trade_outcome', (outcome) => {
  // Position closed (48h+ later)
});

engine.on('kill_switch', ({ reason }) => {
  // Kill switch triggered
});

engine.on('risk_mode_changed', ({ mode }) => {
  // Switched to/from survival mode
});

engine.on('daily_summary', (summary) => {
  // Daily stats (auto-emitted at reset hour)
});

engine.on('error', ({ error, signal }) => {
  // Processing error
});
```

## Integration

### With Python ML Models

Start model server:
```bash
python ml/model_server.py --port 5000
```

Engine calls: `POST http://localhost:5000/predict`

Fallback: TypeScript heuristic if server unavailable.

### With Token Signal Source

```typescript
// Replace signal generation with real source
const signals = await tokenApiClient.getLatestLaunches();

for (const signal of signals) {
  await engine.processSignal(signal);
}
```

### With DEX/Broker

```typescript
engine.on('trade_entry', async (position) => {
  // Send real trade order to broker
  const txHash = await broker.buyToken(position.mint, position.entrySizeSol);
});

// Later, when closing
engine.recordTradeOutcome(outcome);
```

## Scenario Testing

Run all scenarios:
```bash
npm run scenarios
```

Output includes:
- Per-scenario: trades, PnL, Sharpe, max DD, win rate, fill rate, latency
- Regime breakdown: trades and PnL per regime
- Bucket breakdown: size and PnL per bucket
- Aggregate summary

## Examples

See `examples/complete-trading-example.ts` for:
1. Basic usage with event monitoring
2. Risk management and kill switches
3. Regime detection and adaptive sizing
4. Full scenario testing
5. Batch signal processing

Run examples:
```bash
npx ts-node examples/complete-trading-example.ts
```

## Files

**Core Engine**:
- `src/engine/types.ts` — Type definitions
- `src/engine/hard-filter.ts` — Fast rejection layer
- `src/engine/ml-ranker.ts` — Multi-target ML ranker
- `src/engine/regime-detector.ts` — 4-state regime classifier
- `src/engine/dynamic-sizer.ts` — Intelligent position sizing
- `src/engine/risk-manager.ts` — Risk guardrails
- `src/engine/execution-router.ts` — Order execution
- `src/engine/feedback-loop.ts` — Retraining orchestration
- `src/engine/pipeline.ts` — Pipeline orchestrator
- `src/engine/trading-engine-orchestrator.ts` — Main API
- `src/engine/scenario-tester.ts` — Scenario runner
- `src/engine/summary-report.ts` — Reporting

**Documentation**:
- `TRADING_ENGINE_GUIDE.md` — Complete usage guide
- `ARCHITECTURE.md` — System design details
- `examples/complete-trading-example.ts` — Usage examples

**Integration**:
- `ml/model_server.py` — Python ML bridge

**Testing**:
- `src/engine/__tests__/integration.test.ts` — Integration tests

## Development

```bash
# Build
npm run build

# Type check
npx tsc --noEmit

# Lint
npm run lint

# Test
npm test

# Watch
npm run dev
```

## Production Deployment

1. **Configure** risk profile and caps
2. **Load** trained ML models (or use heuristic fallback)
3. **Connect** token signal source
4. **Integrate** with DEX/broker for live execution
5. **Monitor** via events and daily summaries
6. **Adjust** risk mode dynamically based on performance
7. **Retrain** weekly with feedback loop

## Performance Tips

- **Increase throughput**: Set `maxTradesPerSecond` higher (max ~100)
- **Reduce latency**: Use local ML heuristic instead of Python server
- **Increase size**: Reduce daily drawdown limit or increase risk caps in ACCELERATING
- **Reduce risk**: Lower `maxRiskPerTradePct` or enable survival mode earlier
- **Improve fills**: Adjust `ExecutionRouter` slippage/failure rate for backtesting
- **Retrain often**: Lower `minRecordsForRetrain` threshold (min 20–30)

## Constraints & Design Decisions

- **No ML override of hard rejects**: Safety critical
- **Parallel API calls**: Fast filtering without blocking
- **Fail-safe defaults**: Timeout = reject, error = reject
- **TypeScript strict mode**: No `any`, all types explicit
- **Production-grade**: Designed for live trading, not research
- **Regime-aware**: All sizing multiplied by regime state
- **Survival mode**: Auto-triggered to preserve capital
- **Throttled throughput**: Max trades/sec prevent rate limit exhaustion

## License

MIT

## Support

For questions, issues, or contributions:
- See `TRADING_ENGINE_GUIDE.md` for detailed usage
- See `ARCHITECTURE.md` for system design
- Check `examples/` for code samples
- Run integration tests: `npm test`

---

**Built for aggressive memecoin opportunity capture at scale.**
**Target: $1M–$3M/day gross → 0.6–1.2 Sharpe → 30–35% max DD**
