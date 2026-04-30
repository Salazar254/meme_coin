# Integration Guide: Rug Filter ML System

This document explains how to integrate the TypeScript rug filter system into your existing Solana bot.

## High-Level Integration Steps

1. **Install dependencies** and build TypeScript
2. **Set up Python model server** for ML inference
3. **Create filter instance** in your bot's trade flow
4. **Route trade decisions** through the filter
5. **Log outcomes** 48h later for continual learning
6. **Monitor stats** and retrain weekly

---

## Step 1: Installation & Build

```bash
# Navigate to rug-filter-ts directory
cd rug-filter-ts

# Install dependencies
npm install

# Build TypeScript
npm run build

# Verify compilation
npm run build 2>&1 | grep -i error || echo "✅ Build success"
```

---

## Step 2: Set Up Python Model Server

Your existing Python ML models need to be callable from Node.js. Two options:

### Option A: HTTP Server (Recommended for Production)

Create `ml/model_server.py`:

```python
#!/usr/bin/env python3
import os
import sys
import json
from flask import Flask, request, jsonify
import pickle
import numpy as np
import torch

# Add parent path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ml.xgb_model import XGBModel
from ml.nn_model import NNModel
from ml.evaluate import evaluate_model

app = Flask(__name__)

# Load models (lazy-loaded for speed)
MODELS = {}

def get_model(model_type):
    if model_type not in MODELS:
        if model_type == 'contract':
            MODELS[model_type] = pickle.load(open('ml/saved_models/contract_model.pkl', 'rb'))
        elif model_type == 'wallet':
            MODELS[model_type] = pickle.load(open('ml/saved_models/wallet_model.pkl', 'rb'))
        elif model_type == 'liquidity':
            MODELS[model_type] = pickle.load(open('ml/saved_models/liquidity_model.pkl', 'rb'))
        elif model_type == 'social':
            MODELS[model_type] = pickle.load(open('ml/saved_models/social_model.pkl', 'rb'))
    return MODELS[model_type]

@app.route('/predict', methods=['POST'])
def predict():
    try:
        data = request.json
        model_type = data.get('type', 'contract')
        features = np.array(data['features']).reshape(1, -1)
        
        model = get_model(model_type)
        
        # Get prediction
        pred = model.predict(features[0])
        
        # Get confidence (try different attribute names)
        if hasattr(model, 'predict_proba'):
            proba = model.predict_proba(features)
            confidence = max(proba[0])
        else:
            confidence = 0.7  # Default confidence
        
        return jsonify({
            'score': float(pred) if isinstance(pred, (int, float, np.number)) else float(pred[0]),
            'confidence': float(confidence)
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/anomaly', methods=['POST'])
def anomaly():
    try:
        data = request.json
        features = np.array(data['features']).reshape(1, -1)
        
        # Load autoencoder
        ae_model = torch.load('ml/saved_models/autoencoder.pt')
        ae_model.eval()
        
        with torch.no_grad():
            tensor = torch.FloatTensor(features)
            output = ae_model(tensor)
            reconstruction_error = float(torch.mean((tensor - output) ** 2).item())
        
        return jsonify({
            'reconstruction_error': reconstruction_error
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})

if __name__ == '__main__':
    port = int(os.getenv('MODEL_SERVER_PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
```

**Start the server:**

```bash
# In a separate terminal
export FLASK_ENV=production
export MODEL_SERVER_PORT=5000
python ml/model_server.py
```

**Then set in `.env`:**

```
PYTHON_SERVER_URL=http://localhost:5000
```

### Option B: Direct Subprocess (Simple Setup)

Models will be called directly via subprocess. Ensure each model script outputs JSON:

```python
# ml/contract_model_inference.py
import sys
import json
import pickle
import numpy as np

model = pickle.load(open('ml/saved_models/contract_model.pkl', 'rb'))
features = np.array(json.loads(sys.argv[1]))
pred = model.predict(features.reshape(1, -1))[0]
proba = model.predict_proba(features.reshape(1, -1))[0]

print(json.dumps({
    'score': float(pred),
    'confidence': float(max(proba))
}))
```

**Then set in `.env`:**

```
CONTRACT_MODEL_PATH=./ml/contract_model_inference.py
# Don't set PYTHON_SERVER_URL
```

---

## Step 3: Create Filter Instance in Bot

Modify your `src/event_handler.py` or equivalent bot entry point:

### Python → Node.js Bridge

Create `src/rug_filter_bridge.py`:

```python
"""
Bridge to communicate with TypeScript rug filter system.
Can use HTTP requests or subprocess calls.
"""

import subprocess
import json
import asyncio
import aiohttp
from typing import Dict, Any, Optional

class RugFilterBridge:
    def __init__(self, node_process_path: str = "node", enable_http: bool = False):
        self.node_process_path = node_process_path
        self.enable_http = enable_http
        self.process = None
        
        if enable_http:
            self.base_url = "http://localhost:3000"  # Node.js server port

    def start_filter_server(self):
        """Start Node.js rug filter server in background"""
        if self.enable_http and not self.process:
            self.process = subprocess.Popen(
                [self.node_process_path, "rug-filter-ts/dist/server.js"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )

    async def evaluate_token(
        self, 
        token_address: str, 
        chain: str = "solana",
        portfolio_context: Optional[Dict[str, float]] = None
    ) -> Dict[str, Any]:
        """
        Evaluate token via rug filter.
        Returns decision dict.
        """
        if self.enable_http:
            return await self._evaluate_http(token_address, chain, portfolio_context)
        else:
            return await self._evaluate_subprocess(token_address, chain, portfolio_context)

    async def _evaluate_http(self, token_address: str, chain: str, portfolio_context):
        """HTTP-based evaluation (requires Node.js server)"""
        async with aiohttp.ClientSession() as session:
            payload = {
                "tokenAddress": token_address,
                "chain": chain,
                "portfolio": portfolio_context
            }
            async with session.post(f"{self.base_url}/evaluate", json=payload) as resp:
                if resp.status == 200:
                    return await resp.json()
                else:
                    return {"error": "Rug filter server error"}

    async def _evaluate_subprocess(self, token_address: str, chain: str, portfolio_context):
        """Subprocess-based evaluation (direct ts-node call)"""
        cmd = [
            "npx", "ts-node",
            "rug-filter-ts/src/evaluate.ts",
            token_address,
            chain,
            json.dumps(portfolio_context or {})
        ]
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        stdout, stderr = await process.communicate()
        
        if process.returncode == 0:
            return json.loads(stdout.decode())
        else:
            print(f"Rug filter error: {stderr.decode()}")
            return {"error": "Evaluation failed"}

    def cleanup(self):
        """Stop filter server"""
        if self.process:
            self.process.terminate()
            self.process.wait()
```

### Usage in Bot

Modify `src/event_handler.py`:

```python
import sys
import asyncio
from rug_filter_bridge import RugFilterBridge

class EventHandler:
    def __init__(self, config):
        super().__init__()
        self.config = config
        
        # Initialize rug filter
        self.rug_filter = RugFilterBridge(enable_http=False)
        self.rug_filter.start_filter_server()

    async def on_token_detected(self, event):
        """Called when new token is detected"""
        
        token_address = event['mint']
        
        # Get portfolio state
        portfolio_context = {
            'currentDrawdownPct': self.get_current_dd(),
            'peakCapital': self.peak_capital,
            'currentCapital': self.current_capital,
            'openPositions': len(self.open_positions),
            'maxOpenPositions': 5,
            'dailyPnL': self.daily_pnl,
            'sharpeRatio': self.compute_sharpe()
        }
        
        # ✅ CRITICAL: Evaluate token with rug filter
        decision = await self.rug_filter.evaluate_token(
            token_address,
            chain='solana',
            portfolio_context=portfolio_context
        )
        
        # Check decision
        if decision.get('error'):
            logger.warning(f"Rug filter error: {decision['error']}")
            return
        
        if decision['decision'] in ['REJECT', 'SKIP']:
            logger.info(f"Token {token_address} rejected by rug filter (score {decision['finalScore']:.1f})")
            return
        
        # Use filter's position size recommendation
        position_size = self.base_position_size * decision['positionSize']
        
        logger.info(
            f"Token {token_address}: {decision['decision']} "
            f"(score {decision['finalScore']:.1f}, pos_size {position_size:.2f})"
        )
        
        # Place trade with adjusted position size
        await self.place_trade(token_address, position_size)
        
        # Store for outcome tracking
        self.pending_outcomes[token_address] = {
            'timestamp': event['timestamp'],
            'launch_price': event['price'],
            'decision_timestamp': time.time()
        }

    async def label_outcome(self, token_address: str, outcome: str):
        """Called 48h later to label outcome"""
        if token_address not in self.pending_outcomes:
            return
        
        record = self.pending_outcomes[token_address]
        
        # Call rug filter to log outcome
        cmd = [
            "npx", "ts-node",
            "rug-filter-ts/src/label-outcome.ts",
            token_address,
            str(record['timestamp']),
            outcome
        ]
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        stdout, stderr = await process.communicate()
        
        if process.returncode == 0:
            logger.info(f"Outcome labeled: {token_address} -> {outcome}")
        else:
            logger.error(f"Outcome label error: {stderr.decode()}")
        
        del self.pending_outcomes[token_address]
```

---

## Step 4: Database Schema

Ensure the following tables exist (created automatically by rug filter):

```sql
-- feedback_records: created by FeedbackLogger
CREATE TABLE feedback_records (
    id INTEGER PRIMARY KEY,
    address TEXT UNIQUE,
    timestamp INTEGER,
    decision_str TEXT,
    position_size REAL,
    score REAL,
    outcome TEXT,
    labeled INTEGER,
    created_at INTEGER
);

-- regime_history: created by RegimeDetector
CREATE TABLE regime_history (
    id INTEGER PRIMARY KEY,
    timestamp INTEGER,
    miss_rate_48h REAL,
    regime TEXT
);
```

No manual setup needed—tables are auto-created on first filter initialization.

---

## Step 5: Weekly Retraining

Add to your bot's scheduler (e.g., via APScheduler):

```python
from apscheduler.schedulers.background import BackgroundScheduler
import subprocess

scheduler = BackgroundScheduler()

def weekly_retrain():
    """Trigger weekly rug filter retraining"""
    print("🔄 Starting weekly rug filter retrain...")
    
    result = subprocess.run(
        ["npm", "run", "retrain"],
        cwd="rug-filter-ts",
        capture_output=True,
        text=True,
        timeout=600  # 10 min timeout
    )
    
    if result.returncode == 0:
        print("✅ Retrain successful")
    else:
        print(f"❌ Retrain failed: {result.stderr}")

# Schedule every Monday at 2 AM
scheduler.add_job(weekly_retrain, 'cron', day_of_week=0, hour=2)
scheduler.start()
```

---

## Step 6: Monitoring

Add stats collection to your dashboard:

```python
def get_rug_filter_stats():
    """Fetch rug filter statistics"""
    result = subprocess.run(
        ["npx", "ts-node", "rug-filter-ts/src/get-stats.ts"],
        capture_output=True,
        text=True
    )
    
    if result.returncode == 0:
        return json.loads(result.stdout)
    
    return None

# In your metrics collection:
stats = get_rug_filter_stats()
if stats:
    print(f"Rug filter accuracy: {stats['feedback']['buyAccuracy']}%")
    print(f"Regime: {stats['regime']['currentRegime']}")
```

---

## Stress Testing Integration

Run your existing stress tests with the filter enabled:

```bash
python run_million_scenario_tests.py \
    --rug-filter-enabled \
    --rug-filter-path ./rug-filter-ts \
    --target-sharpe 0.8 \
    --target-dd 30
```

The filter will:
1. Evaluate each token in scenario
2. Apply position sizing + DD controls
3. Track outcomes
4. Report final Sharpe/DD/PnL metrics

---

## Troubleshooting

### Models not found

```bash
# Verify model paths
find . -name "*.pt" -o -name "*.pkl" -o -name "*.json"

# Update .env with correct paths
ANOMALY_MODEL_PATH=./ml/saved_models/autoencoder.pt
CONTRACT_MODEL_PATH=./ml/saved_models/xgb_model.json
# etc.
```

### Model server not responding

```bash
# Verify server is running
curl http://localhost:5000/health

# Check logs
tail -f ~/logs/model_server.log

# Restart if needed
pkill -f "python ml/model_server.py"
python ml/model_server.py > ~/logs/model_server.log 2>&1 &
```

### Slow evaluation

- Check API timeouts in `.env` (should be 300ms)
- Verify Python model server is warm (first call slower)
- Profile with `npm run build && time node dist/test.js`

### Feedback DB disk full

```bash
# Check size
du -h feedback.db

# Cleanup old records (keep last 6 months)
sqlite3 feedback.db "DELETE FROM feedback_records WHERE created_at < datetime('now', '-6 months');"
```

---

## Performance Checklist

- [ ] API timeouts set to 300ms per call
- [ ] Python model server running and responsive
- [ ] Feedback DB regularly vacuumed
- [ ] Weekly retraining scheduled and monitored
- [ ] Regime detector checks enabled
- [ ] DD-linked position sizing active
- [ ] Outcome labeling happening 48h post-trade

---

## Next Steps

1. Deploy to staging environment
2. Run 1-week backtest with filter enabled
3. Monitor Sharpe ratio and DD
4. Adjust thresholds if needed
5. Deploy to production
6. Monitor daily for regime shifts
