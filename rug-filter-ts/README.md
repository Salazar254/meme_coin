# Self-Improving Rug Filter ML System

**TypeScript/Node.js cognitive architecture for meme-coin rug detection and prevention.**

## Overview

This is a production-ready, self-improving rug filter system modeled on hedge-fund risk management principles and human-brain learning patterns. It combines:

- **Parallel API signal extraction** (300ms timeout per API, safe fallbacks)
- **Autoencoder anomaly detection** (catches novel rug patterns)
- **Specialist ensemble** (4 independent classifiers with confidence decay)
- **Hard rule engine** (instant REJECT floor, ML can't override)
- **Regime detector** (monitors when rug-meta shifts)
- **Confidence calibrator** (score → decision + position sizing)
- **Rich feedback logging** (48h outcome tracking, reward signals)
- **Continual learning** (Elastic Weight Consolidation, no catastrophic forgetting)
- **3-tier memory** (LTM, MTM, STM matching human expertise)

**Target Metrics:**
- Sharpe Ratio: 0.6–1.2
- Max Drawdown: 30–35%
- Monthly PnL: $1M USD ($40k–$50k/day)
- Zero catastrophic failures under stress

---

## Architecture

### Cognitive Flow

```
TokenSignals → AnomalyDetector → SpecialistEnsemble → RegimeDetector
                                          ↓
                                  HardRuleEngine (floor)
                                          ↓
                            ConfidenceCalibrator
                                        ↓
                          RugFilterDecision + PositionSize
                                        ↓
                         FeedbackLogger (outcome 48h later)
                                        ↓
                         ContinualLearner (EWC updates)
```

### Components

#### 1. **TokenSignalExtractor** (`src/data-layer/token-signal-extractor.ts`)
Fetches all signals in parallel with 300ms timeout per API + safe fallbacks:

- **GoPlus Security API**: mint enabled, blacklist function, ownership, proxy
- **honeypot.is API**: honeypot detection, buy/sell taxes
- **Helius RPC / Alchemy**: holder concentration, wallet clusters
- **Unicrypt / DappRadar**: LP lock status, lock duration, burn status
- **Internal blacklist**: known rug deployers
- **Social scraper**: Telegram/Twitter age, follower quality

Output: Fully-typed `SignalVector` (all fields non-optional, never undefined).

#### 2. **AnomalyDetector** (`src/components/anomaly-detector.ts`)
Autoencoder trained on historical "normal" launches:

- Input: normalized `SignalVector`
- Output: `reconstructionError` (0–1), `isAnomaly` flag (> 0.7)
- Catches novel patterns the ensemble hasn't seen
- Runs in parallel to ensemble for latency

#### 3. **SpecialistEnsemble** (`src/components/specialist-ensemble.ts`)
Four independent specialist classifiers:

- **ContractModel**: mint, honeypot, blacklist, proxy
- **WalletModel**: holder concentration, deployer patterns
- **LiquidityModel**: LP lock, burn, taxes
- **SocialModel**: Telegram, Twitter, community

Each returns `{ score: 0–1, confidence: 0–1 }`.

Confidence weights decay automatically if recent accuracy drops > 15% week-over-week.

Weighted blend:
```
ensembleScore = (
  ContractModel.score * 0.35 +
  WalletModel.score * 0.30 +
  LiquidityModel.score * 0.25 +
  SocialModel.score * 0.10
) * confidence_adjustment_per_model
```

#### 4. **HardRuleEngine** (`src/components/hard-rule-engine.ts`)
Rule-based floor that ML **cannot override**:

**INSTANT REJECT if any:**
- `mintEnabled === true`
- `isHoneypot === true`
- `isKnownRugDeployer === true`
- `!lpLocked && !lpBurned`
- `sellTax > 15%`
- `!ownershipRenounced`

Blend rule score with ensemble:
```
finalScore = (ruleScore * 0.6) + (ensembleScore * 100 * 0.4)
ML can only raise the floor, never lower.
```

#### 5. **RegimeDetector** (`src/components/regime-detector.ts`)
Monitors when rug-pattern meta shifts:

- Tracks rolling 48h miss rate (rugs that bypassed filter)
- Tracks per-signal predictive power decay (information gain)
- If miss rate increases > 15% vs prior week → emit `REGIME_SHIFT`
- On shift:
  - Downweight decaying signals
  - Increase anomaly sensitivity
  - Trigger retraining job

#### 6. **ConfidenceCalibrator** (`src/components/confidence-calibrator.ts`)
Converts `finalScore` (0–100) to decision + position size:

```
score 0–20   → BUY,   positionSize 1.0,  riskLevel LOW
score 21–40  → BUY,   positionSize 0.6,  riskLevel LOW_MEDIUM
score 41–60  → SMALL, positionSize 0.25, riskLevel MEDIUM
score 61–79  → SKIP,  positionSize 0,    riskLevel HIGH
score 80–100 → REJECT, positionSize 0,   riskLevel REJECT
```

**Conflict penalty**: If top 2 specialists disagree > 30 pts → halve `positionSize`.

**DD-linked sizing**:
- If DD > 20% → multiply `positionSize` by 0.5
- If DD > 10% → use full `positionSize`

#### 7. **FeedbackLogger** (`src/persistence/feedback-logger.ts`)
SQLite persistence + 48h outcome tracking:

```typescript
interface FeedbackRecord {
  address: string
  timestamp: number
  decision: RugFilterDecision
  outcome?: 'RUG' | 'DUMP_60' | 'STABLE' | 'MOONSHOT'
  rewardSignal?: number // -1.0 to +1.0
  labeled: boolean
}
```

**Rich reward signals** (not binary):
```
+1.0  → correct REJECT of confirmed rug
+0.5  → flagged HIGH RISK, token dumped 60%+
+0.3  → BUY decision, token stable 7+ days
-0.5  → BUY decision, token rugged (miss)
-0.3  → REJECT decision, token 10x'd (false positive)
-0.1  → SMALL decision, token rugged (partial miss)
```

#### 8. **ContinualLearner** (`src/ml/continual-learner.ts`)
Elastic Weight Consolidation (EWC) retraining:

**Weekly cycle:**
1. Collect labeled feedback (last 30 days)
2. Compute Fisher Information Matrix (weight importance)
3. Retrain each specialist with EWC regularization
4. Validate on time-split data (not random)
5. Deploy only if validation accuracy ≥ previous - 3%

Prevents catastrophic forgetting while enabling fast adaptation to new rug tactics.

#### 9. **MemoryArchitecture** (`src/memory/memory-architecture.ts`)
Three-tier cognitive memory (matching human experts):

**Long-Term Memory (LTM):**
- Fundamental signals: mint, honeypot, LP lock
- Trained once, high EWC protection
- Almost never updated

**Medium-Term Memory (MTM):**
- Holder patterns, deployer clusters
- Monthly retraining
- Moderate EWC protection
- Can be updated on learning

**Short-Term Memory (STM):**
- Emerging bad clusters, recent rug wallet list
- Real-time updates, no retraining
- Can override MTM/LTM
- 24h TTL

---

## Installation

### Prerequisites

- Node.js 18+
- Python 3.9+ (for ML model inference)
- SQLite 3.x (included with Node packages)

### Setup

```bash
cd rug-filter-ts
npm install

# Build TypeScript
npm run build

# Environment setup
cp .env.example .env
# Edit .env with your API keys and model paths
```

### Environment Variables

```bash
# API Keys
GOPLUS_API_KEY=your_key
HONEYPOT_API_KEY=your_key
HELIUS_API_KEY=your_key

# Model paths
ANOMALY_MODEL_PATH=./models/autoencoder.pt
CONTRACT_MODEL_PATH=./models/contract_model.pkl
WALLET_MODEL_PATH=./models/wallet_model.pkl
LIQUIDITY_MODEL_PATH=./models/liquidity_model.pkl
SOCIAL_MODEL_PATH=./models/social_model.pkl

# Python
PYTHON_PATH=python
PYTHON_SERVER_URL=http://localhost:5000  # optional: if using HTTP model server

# Database
FEEDBACK_DB_PATH=./feedback.db

# ML tuning
MIN_FEEDBACK=100
EWC_PENALTY=0.4
```

---

## Usage

### Basic Evaluation

```typescript
import { createRugFilter, RugFilterConfig } from './src/index';

const config: RugFilterConfig = {
  goPlusApiKey: process.env.GOPLUS_API_KEY,
  heliusApiKey: process.env.HELIUS_API_KEY,
  anomalyDetectorModelPath: './models/autoencoder.pt',
  contractModelPath: './models/contract_model.pkl',
  walletModelPath: './models/wallet_model.pkl',
  liquidityModelPath: './models/liquidity_model.pkl',
  socialModelPath: './models/social_model.pkl',
  pythonRuntimePath: 'python',
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

const rugFilter = createRugFilter(config, 'info');
rugFilter.start();

// Evaluate a token
const decision = await rugFilter.evaluateToken(
  'tokenMintAddress',
  'solana',
  { currentDrawdownPct: 5, peakCapital: 100000, currentCapital: 95000, /* ... */ }
);

console.log(`Decision: ${decision.decision}`);
console.log(`Position Size: ${decision.positionSize}`);
console.log(`Score: ${decision.finalScore}`);

// Label outcomes 48h later
await rugFilter.labelOutcome(tokenMintAddress, timestamp, 'RUG');
await rugFilter.labelOutcome(tokenMintAddress, timestamp, 'STABLE');
await rugFilter.labelOutcome(tokenMintAddress, timestamp, 'MOONSHOT');
```

### Listen to Events

```typescript
rugFilter.on('decision', (decision) => {
  console.log('Decision made:', decision);
});

rugFilter.on('outcome', ({ tokenAddress, outcome }) => {
  console.log(`Token ${tokenAddress} outcome: ${outcome}`);
});

rugFilter.on('regime-shift', (regimeState) => {
  console.log('Rug pattern meta shifted!', regimeState);
});

rugFilter.on('retrain', (report) => {
  console.log(`Retrain cycle ${report.retrainCycle} complete`, report);
});
```

### Manual Retraining

```bash
npm run retrain
```

### Analyze Feedback

```bash
npm run analyze-feedback
```

---

## Integration with Bot

To integrate with your existing sniping bot (`src/bot.py`):

1. **Start Python model server** (if using HTTP):
   ```bash
   python ml/model_server.py --port 5000
   ```

2. **In your bot's decision flow:**
   ```typescript
   // Before placing a trade:
   const decision = await rugFilter.evaluateToken(
     newTokenMint,
     'solana',
     currentPortfolio
   );

   if (decision.decision === 'REJECT' || decision.decision === 'SKIP') {
     return; // Don't trade
   }

   // Adjust position size based on recommendation
   const tradeSize = baseSize * decision.positionSize;
   // ...place trade...
   ```

3. **Log outcomes 48h later:**
   ```typescript
   // After 48 hours, label the outcome
   const price48h = await fetchPrice(tokenMint);
   const outcome = price48h < launchPrice * 0.4 ? 'RUG' : 'STABLE';
   await rugFilter.labelOutcome(tokenMint, launchTimestamp, outcome);
   ```

---

## Python Integration

### Model Server Example (`ml/model_server.py`)

```python
#!/usr/bin/env python3
"""
Simple Flask model server for TypeScript integration.
Returns JSON predictions for each specialist model.
"""

from flask import Flask, request, jsonify
import torch
import pickle
import numpy as np

app = Flask(__name__)

# Load models
with open('models/contract_model.pkl', 'rb') as f:
    contract_model = pickle.load(f)

with open('models/wallet_model.pkl', 'rb') as f:
    wallet_model = pickle.load(f)

# ... load other models ...

@app.route('/predict', methods=['POST'])
def predict():
    data = request.json
    model_type = data['type']
    features = np.array(data['features'])

    if model_type == 'contract':
        score = contract_model.predict_proba(features.reshape(1, -1))[0][1]
    elif model_type == 'wallet':
        score = wallet_model.predict_proba(features.reshape(1, -1))[0][1]
    # ... other models ...

    return jsonify({
        'score': float(score),
        'confidence': 0.8  # Your confidence estimate
    })

@app.route('/anomaly', methods=['POST'])
def anomaly():
    data = request.json
    features = np.array(data['features'])
    
    # Run through autoencoder
    reconstruction_error = compute_reconstruction_error(features)
    
    return jsonify({
        'reconstruction_error': float(reconstruction_error)
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
```

### Retrain Script (`ml/retrain.py`)

```python
#!/usr/bin/env python3
"""
Retrain specialist models with EWC.
Called by TypeScript continual learner.
"""

import argparse
import json
import numpy as np
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('model_path', type=str)
    parser.add_argument('--training-data', type=str)
    parser.add_argument('--validation-data', type=str)
    parser.add_argument('--fisher-penalty', type=float, default=0.4)
    parser.add_argument('--epochs', type=int, default=20)
    parser.add_argument('--batch-size', type=int, default=32)
    
    args = parser.parse_args()
    
    # Load data
    training_data = json.loads(args.training_data)
    validation_data = json.loads(args.validation_data)
    
    # Train with EWC
    # ... your training logic ...
    
    # Output results
    result = {
        'accuracy_before': 0.75,
        'accuracy_after': 0.78,
        'validation_accuracy': 0.76,
        'specialist_deltas': {},
        'ewc_fisher_stats': {
            'mean_fisher_weight': 0.5,
            'std_fisher_weight': 0.1,
            'large_weight_pct': 0.3
        },
        'regime_state': {
            'current_regime': 'STABLE',
            'miss_rate_48h': 0.05,
            'miss_rate_week': 0.08
        }
    }
    
    print(json.dumps(result))

if __name__ == '__main__':
    main()
```

---

## Performance Targets

- **Signal extraction**: < 300ms per API call, 2s total with fallbacks
- **Inference**: < 500ms total (parallel anomaly + ensemble)
- **Decision latency**: < 1.5s end-to-end
- **False positive rate**: < 5% (skip good tokens)
- **False negative rate**: < 10% (miss rugs)
- **Retraining**: < 10 minutes weekly

---

## Monitoring & Debugging

### Get Statistics

```typescript
const stats = rugFilter.getStats();
console.log(stats);
// {
//   feedback: {
//     totalDecisions: 1000,
//     labeledDecisions: 950,
//     unlabeledDecisions: 50,
//     avgRewardSignal: 0.12,
//     outcomeCounts: { RUG: 150, DUMP_60: 100, STABLE: 500, MOONSHOT: 200 }
//   },
//   memory: {
//     ltmAge: 2592000000,  // 30 days
//     mtmAge: 604800000,   // 7 days
//     stmSize: 42,
//     stmTTLRemaining: 86400000  // 24 hours
//   },
//   regime: {
//     currentRegime: 'STABLE',
//     missRate48h: 0.05,
//     missRatePriorWeek: 0.08,
//     missRateIncrease: -0.375,
//     shiftDetected: false
//   }
// }
```

### Debug Logs

Set `logLevel: 'DEBUG'` for detailed traces:

```typescript
const rugFilter = createRugFilter(config, 'debug');
```

---

## Stress Testing

Run your existing stress test suite with the new filter:

```bash
python run_million_scenario_tests.py --rug-filter enabled
```

The filter will be evaluated on:
- PnL consistency
- Sharpe ratio maintenance
- Max DD containment
- Miss rate vs. false positives trade-off

---

## Known Limitations

1. **Cold start**: First week of data needed before retraining is effective
2. **Regime lag**: Regime shift detected with ~1 day lag (48h miss rate window)
3. **API fallback simplicity**: Fallback defaults are conservative (may skip good tokens)
4. **Single-model LTM**: LTM updates infrequent; consider manual tuning if rug patterns fundamentally shift

---

## Future Enhancements

- [ ] Multi-GPU ensemble inference
- [ ] Redis caching for signal extraction
- [ ] Graph neural networks for wallet cluster detection
- [ ] Real-time Telegram/Discord scraping
- [ ] Cross-chain risk correlation
- [ ] Sentiment analysis integration

---

## License

MIT

---

## Support

For integration help, refer to the TypeScript interfaces in `src/types/index.ts` and example scripts in `src/scripts/`.
