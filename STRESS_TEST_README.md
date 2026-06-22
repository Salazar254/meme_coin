# Stress-Test & De-Overfitting Framework

This framework stress-tests the meme-coin sniping strategy across **1M+ simulated trades** using scenario-based Monte Carlo analysis to expose weaknesses and detect overfitting.

---

## 📋 Overview

### Problem
The strategy shows suspiciously high stats on 254 historical trades:
- **+1,125% PnL** 
- **9.09 Profit Factor**
- **5.83 Sharpe Ratio**
- **2.9% Max Drawdown**

These metrics are unrealistically good and likely indicate **overfitting to historical data**.

### Solution
Run the strategy against:
1. **Clean synthetic data** (baseline)
2. **Noisy/corrupted data** (robustness)
3. **Parameter sweeps** (sensitivity)
4. **Regime shifts** (regime robustness)
5. **Extreme stress conditions** (stress testing)

---

## 🚀 Quick Start

### 1. Generate Scenario Results
```bash
# Generate 100K events and run all 5 scenarios (A-E)
python run_million_scenario_tests.py --num-events 100000 --seed 42

# Run specific scenarios
python run_million_scenario_tests.py --num-events 100000 --scenarios A,D,E

# Use 1M events for comprehensive testing
python run_million_scenario_tests.py --num-events 1000000 --seed 42
```

**Output**: `results/scenario_results.csv`

### 2. Analyze Results
Open the Jupyter notebook:
```bash
jupyter notebook analyze_scenario_results.ipynb
```

Or run the analysis:
```python
import pandas as pd

df = pd.read_csv('results/scenario_results.csv')
print(df.groupby('scenario')[['sharpe_ratio', 'profit_factor', 'pnl_pct']].mean())
```

---

## 📊 Scenarios Explained

### **Scenario A: Base-Case**
- Clean, unmodified data
- **Purpose**: Establish baseline performance
- **Expected**: Highest Sharpe/PnL (but may be optimistic)

### **Scenario B: Noise-Robustness**
- 10% of events get ±5-10% noise on LP, buyers, volume
- 5% of events become "fake launches" (zero LP/buyers)
- **Purpose**: Test if strategy blindly trades garbage
- **If Sharpe drops 50%+**: Strategy is NOT robust

### **Scenario C: Parameter-Sweep**
- LP threshold: ±20% multipliers (0.8, 0.9, 1.0, 1.1, 1.2)
- **Purpose**: Detect overfitting to specific thresholds
- **If tiny changes cause huge PnL swings**: Overfitting!

### **Scenario D: Regime-Shifts**
- Data divided into 3 blocks: **Bull** (high LP, great PnL) → **Flat** (normal) → **Bear** (low LP, negative PnL)
- **Purpose**: Most realistic market simulation
- **Expected**: Sharpe degrades in bear block
- **Key insight**: Real performance will resemble the bear block

### **Scenario E: Stress Market**
- 15% of events are extreme conditions:
  - **Rug-pulls**: Price collapses to -99%
  - **Low LP**: Extreme slippage
  - **Negative events**: -50% to -80% losses
- **Purpose**: Test if a few huge losses wipe out many small wins
- **If strategy crashes**: Position sizing is too aggressive

---

## ⚠️ Overfitting Red Flags

The framework automatically detects these warning signs:

### **Flag 1: Extreme Sharpe + Low Drawdown**
```
Sharpe > 3.0 AND Max Drawdown < 5%
```
✗ **Suspicious** — Real strategies have higher drawdowns
- Suggests data curve-fitting or look-ahead bias

### **Flag 2: High Profit Factor + Low Win Rate**
```
Profit Factor > 8 AND Win Rate < 40%
```
✗ **Unrealistic** — Means a few huge wins carry most trades
- Very fragile to slippage/execution issues

### **Flag 3: Sharpe Varies >1.0 Across Scenarios**
✗ **Parameter dependent** — Strategy is over-sensitive
- Small threshold changes cause large performance swings

### **Flag 4: Scenario-B (Noise) PnL drops >50%**
✗ **Not robust** — Strategy can't handle realistic conditions
- Will fail in live trading with liquidity/latency variations

### **Flag 5: Regime D (Bear) Turns Negative**
✗ **Regime dependent** — Strategy only works in bull markets
- Will suffer massive losses in downturns

---

## 📈 Metrics Explained

| Metric | Formula | Interpretation |
|--------|---------|-----------------|
| **Win Rate** | wins / total trades | % of profitable trades |
| **Sharpe Ratio** | (mean return / std return) × √365 | Risk-adjusted return (2.0+ is good) |
| **Profit Factor** | gross_profit / gross_loss | Ratio of total wins to total losses (2.0+ is good) |
| **PnL %** | (final_equity - initial) / initial | Total return percentage |
| **Max Drawdown %** | peak_equity - trough / peak_equity | Worst peak-to-trough decline |
| **Expectancy** | mean PnL per trade | Average trade profit/loss |

---

## 🔧 Configuration & Tuning

### Adjust Scenario Parameters

Edit the scenario definitions in `run_million_scenario_tests.py`:

```python
ScenarioConfig(
    name="B_NoiseRobustness",
    noise_fraction=0.10,        # ← Change from 10% to 20%
    fake_launch_fraction=0.05,  # ← Change fake launches
)
```

### Adjust Event Generation

Modify `EventDataGenerator` to match your market:

```python
# Increase LP distribution (more liquidity events)
lp_median = 5.0  # Was 2.5

# More aggressive price movements
pnl_1m = self.rng.normal(0.10, 0.20)  # Was 0.05, 0.15

# Fewer buyer events (realistic)
buyers_median = 20  # Was 30
```

### Adjust Strategy Parameters

The backtest engine uses these from `config/config.toml`:

```toml
[strategy]
min_lp_sol = 0.5              # Minimum LP threshold
min_unique_buyers = 5         # Minimum buyers requirement
default_position_sol = 0.1    # Position size
max_spend_per_token_sol = 0.5 # Max per trade
take_profit_multiplier = 2.0  # 2x = 100% gain target
stop_loss_fraction = 0.5      # 50% loss cutoff
```

---

## 📊 Interpreting Results

### Example 1: GOOD Results ✅
```
Scenario A (Base):        Sharpe=2.5, Win Rate=55%, Profit Factor=3.0, Max DD=8%
Scenario B (Noise):       Sharpe=2.2, Win Rate=52%, Profit Factor=2.8, Max DD=10%
Scenario C (Params):      Consistent across param values (no jumps)
Scenario D (Regimes):     Sharpe=2.0 in bear, PnL slightly negative OK
Scenario E (Stress):      Sharpe=1.5, Max DD=15% (acceptable degradation)

→ Strategy is ROBUST
```

### Example 2: BAD Results ❌
```
Scenario A (Base):        Sharpe=5.8, Win Rate=33%, Profit Factor=9.1, Max DD=2.9%
Scenario B (Noise):       Sharpe=0.8, Win Rate=45%, Profit Factor=1.2, Max DD=25%
Scenario C (Params):      0.8× param: Sharpe=4.0, 1.2× param: Sharpe=1.5 (unstable!)
Scenario D (Regimes):     Bear block: PnL=-50%, Strategy losses money
Scenario E (Stress):      Crashes in 5% of trades, needs immediate recovery

→ Strategy is OVERFIT + NOT ROBUST
```

---

## 💾 Output Files

After running `run_million_scenario_tests.py`:

```
results/
├── scenario_results.csv           ← Main results DataFrame
├── scenario_comparison.png        ← Bar charts per scenario
├── parameter_sensitivity.png      ← Sharpe/PnL vs parameters
└── metric_distributions.png       ← Histograms of metrics

analyze_scenario_results.ipynb     ← Full analysis + visualizations
```

## 🔄 Reproducibility

All randomness is seed-based:

```bash
# Same seed = same results
python run_million_scenario_tests.py --seed 42

# Different seed = different event data
python run_million_scenario_tests.py --seed 123
```

---

## 🎯 Decision Tree

Use this to decide if strategy is tradeable:

```
1. Is Scenario A Sharpe > 2.5?
   NO  → ❌ Not profitable, don't trade
   
2. Is Scenario B (Noise) PnL < 20% degradation?
   NO  → ❌ Not robust, don't trade
   
3. Is Scenario C (Params) consistent (Sharpe std < 0.5)?
   NO  → ❌ Overfitting, don't trade
   
4. Is Scenario D (Regimes) positive in bear block?
   NO  → ⚠️  Regime dependent, trade with caution
   
5. Is Scenario E (Stress) Sharpe > 1.0?
   NO  → ❌ Too risky, reduce position size

✅ PASS ALL → Ready for paper trading → Small live test
```

---

## 📞 Troubleshooting

### Scenario results show "0 trades"
- Strategy's filters are too tight
- Check `min_lp_sol` and `min_unique_buyers` in config
- Reduce thresholds in parameter sweep or Scenario C

### Sharpe ratio is NaN
- Need more than 5-10 trades for meaningful Sharpe
- Increase `--num-events` to generate more liquidity

### Profit factor approaches infinity
- Only a few winning trades
- Check if fake launches (Scenario B) are affecting win rate

### Max drawdown explodes in Scenario E
- Position sizing is too aggressive
- Reduce `default_position_sol` in config

---

## 🚀 Integration with Real Strategy

To test YOUR strategy:

1. **Implement strategy function**:
```python
def my_strategy(event: Dict[str, Any], state: Dict[str, Any]) -> Dict[str, Any]:
    """Your custom strategy logic."""
    if event['liquidity_sol'] > 10 and event['unique_buyers'] > 20:
        return {
            "action": "BUY",
            "amount_sol": 0.5,
            "reason": "Good setup",
            "ml_score": 0.85,
        }
    return {"action": "SKIP", "amount_sol": 0, "reason": "No signal"}

# Pass to backtest engine
engine = BacktestEngine(config)
results = engine._simulate(events, my_strategy)
```

2. **Or wrap in runner**:
```python
runner = ScenarioRunner(seed=42)
runner._run_single(events, "MyScenario", "param", 1.0)
```

---

## 📖 Further Reading

- `backtest/engine.py` — Core backtesting logic
- `backtest/metrics.py` — PnL calculation formulas
- `run_million_scenario_tests.py` — Scenario generation code
- `analyze_scenario_results.ipynb` — Analysis template

---

## ✅ Checklist Before Live Trading

- [ ] Run all 5 scenarios with 100K+ events
- [ ] No red flags (Sharpe > 3.0 + low DD not present)
- [ ] Scenario B noise robustness is >80% of baseline
- [ ] Scenario C parameters are consistent (no wild swings)
- [ ] Scenario D bear block is near-breakeven or positive
- [ ] Scenario E stress can withstand 15% extreme events
- [ ] Paper trade for 1-2 weeks in dry-run mode
- [ ] Monitor first week of live trades for regime shifts
- [ ] Have position sizing rules documented and tested

---

**Good luck! 🚀**
