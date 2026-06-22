# Risk Levels Configuration Guide

## Overview

The bot now supports **3 risk levels** to tune performance from conservative to aggressive:

- **`low`**: Safe, testing, early-live (target: 0.3-0.4 Sharpe)
- **`normal`** (default): Production (target: 0.6-0.8 Sharpe) ← **RECOMMENDED**
- **`high`**: 1M-per-month mode (target: 0.8-1.2 Sharpe)

---

## Quick Reference Table

| Aspect | Low | Normal | High |
|--------|-----|--------|------|
| **Max Risk per Trade** | 0.25% | 0.5% | 0.7% |
| **Total Exposure** | 8.0% | 15.0% | 20.0% |
| **Per-Coin Exposure** | 5.0% | 9.0% | 12.0% |
| **Max Position Size** | 0.8 SOL | 1.5 SOL | 2.0 SOL |
| **Concurrent Trades** | 250 | 300 | 350 |
| **Sharpe Target** | 0.3–0.4 | **0.6–0.8** | 0.8–1.2 |
| **Avg Drawdown** | 5–10% | 25–35% | 30–40% |
| **Trade Rejection Rate** | High | Medium | Low |
| **Use Case** | Paper testing | Default production | Scaling to $1M/month |

---

## Survival Mode (All Levels)

When the rolling 30-day Sharpe < 0 AND rolling PnL < 0, the bot auto-enters **survival mode**:

| Level | Survival Risk | Survival Exposure | Survival Trades | ML Multiplier |
|-------|---------------|-------------------|-----------------|---------------|
| Low | 0.12% | 5.0% | 150 | 0.80 |
| Normal | 0.3% | 9.0% | 200 | 0.80 |
| High | 0.4% | 12.0% | 250 | 0.80 |

Survival mode is **less aggressive** than normal mode but **not extreme** (previous: 0.15% risk was too tight).

Logs when triggered:
```
RiskManager → Enabled survival mode: rolling_pnl=-5.23 SOL, rolling_sharpe=-0.15, current_dd=28.5% | 
Risk caps: 0.3% per trade, 9.0% total exposure
```

---

## Configuration

### Using `create_risk_manager()` with `risk_level`

```python
from src.risk_manager import create_risk_manager

# RECOMMENDED: Use risk_level preset
risk_mgr = create_risk_manager(
    bankroll=100.0,           # 100 SOL starting
    risk_level="normal",      # "low", "normal", or "high"
    daily_stop_drawdown_pct=35.0,  # Kill-switch at 35% DD
)

# Then use it normally
state = risk_mgr.build_state()
decision = risk_mgr.assess_signal(signal)
```

### Using with `run_robust_stress_tests.py`

Set environment variable or pass to script:

```bash
# Test with "normal" risk level (default)
python run_robust_stress_tests.py --risk-level normal

# Or test all three levels
python run_robust_stress_tests.py --risk-level low
python run_robust_stress_tests.py --risk-level normal
python run_robust_stress_tests.py --risk-level high
```

### In Your Main Bot Config

Add to your `.env` or `config.toml`:

```toml
[risk]
risk_level = "normal"          # "low", "normal", "high"
daily_stop_drawdown_pct = 35.0
max_concurrent_trades = 300
```

Then in your bot startup:

```python
import os
from src.risk_manager import create_risk_manager

risk_level = os.getenv("RISK_LEVEL", "normal")
risk_mgr = create_risk_manager(
    bankroll=100.0,
    risk_level=risk_level,
    daily_stop_drawdown_pct=35.0,
)
```

---

## When to Use Each Level

### `risk_level="low"` – Testing & Safety

**Use cases:**
- Paper trading on testnet
- Early-live with small capital ($50–$200)
- Validating bot behavior in new markets
- Stress testing infrastructure changes

**Expected performance:**
- Sharpe: 0.3–0.4 (lower due to more blocking)
- Max DD: 5–10% (very conservative)
- Trades executed: ~60–70% (more rejections)
- Freq: Best for <= 100 trades/day

**Example logs:**
```
RiskManager initialized with risk_level='low': 
normal(0.25% risk, 8.0% exposure, 250 trades) | 
survival(0.12% risk, 5.0% exposure, 150 trades)
```

---

### `risk_level="normal"` – Production Default

**Use cases:**
- Live trading with $500–$5K capital
- Reaching 0.6–0.8 Sharpe (your target)
- Balanced risk/reward for steady growth
- Default for all new deployments

**Expected performance:**
- **Sharpe: 0.6–0.8** ✅ (TARGET)
- **Avg DD: 25–35%** ✅ (TARGET)
- Trades executed: ~75–85% (moderate blocking)
- Freq: Optimal for 500–2000 trades/day
- Monthly PnL: $10K–$100K (depends on capital & edge)

**Example logs:**
```
RiskManager initialized with risk_level='normal': 
normal(0.5% risk, 15.0% exposure, 300 trades) | 
survival(0.3% risk, 9.0% exposure, 200 trades)
```

**Stress test results (expected):**
```
Robust Stress Test (50K events × 10 scenarios):
  Avg Sharpe:  0.60–0.65 ✅
  Avg DD:      28–35%    ✅
  Avg PnL:     ~35K SOL
  Profit Factor: 3.5x+   ✅
```

---

### `risk_level="high"` – Scaling to $1M/Month

**Use cases:**
- Large capital ($10K+) with proven edge
- Chasing $1M USD/month target
- High-frequency meme-coin arbitrage
- Only after validating edge in "normal" mode

**Expected performance:**
- Sharpe: 0.8–1.2 (aggressive but sustainable)
- Avg DD: 30–40% (higher but <42% kill-switch)
- Trades executed: ~85–95% (fewer blocks)
- Freq: Supports 3000+ trades/day
- Monthly PnL: $100K–$1M+ (with proper capital)

**Example logs:**
```
RiskManager initialized with risk_level='high': 
normal(0.7% risk, 20.0% exposure, 350 trades) | 
survival(0.4% risk, 12.0% exposure, 250 trades)
```

**Stress test results (expected):**
```
Robust Stress Test (50K events × 10 scenarios):
  Avg Sharpe:  0.70–0.90 ✅
  Avg DD:      32–40%    ✅
  Avg PnL:     ~45K SOL
  Profit Factor: 3.8x+   ✅
```

⚠️ **Warning**: Only use `"high"` after confirming `"normal"` mode works reliably for 1–2 weeks.

---

## Interpreting Sharpe Ratio

In the context of this bot:

- **Sharpe < 0.3**: Edge not yet validated, or too much noise
  - Action: Check rug-filter accuracy, review market conditions
  
- **Sharpe 0.3–0.6**: Edge exists but Sharpe is low (likely due to risk caps blocking good trades)
  - Action: This is the Sharpe 0.21 problem! Move to `"normal"` or `"high"` level
  
- **Sharpe 0.6–0.8**: ✅ **Sweet spot**
  - Means: Consistent, profitable strategy with acceptable risk
  - Action: Keep `risk_level="normal"`, scale capital gradually
  
- **Sharpe 0.8–1.2**: 🚀 **Excellent**
  - Means: Very strong edge, minimal drawdown relative to returns
  - Action: Use `risk_level="high"` to maximize $1M/month potential
  
- **Sharpe > 1.5**: ⚠️ **Suspicious**
  - Red flag: Likely overfitting or unrealistic assumptions
  - Action: Validate on fresh data, check for look-ahead bias

---

## Interpreting Drawdown

- **< 5%**: Very conservative (too many trades blocked)
  - Action: Increase `risk_level`
  
- **5–15%**: Good for early-live
  - Action: OK for paper trading, use `risk_level="low"`
  
- **15–35%**: Normal for profitable strategies
  - Action: This is expected with `risk_level="normal"` ✅
  
- **35–40%**: Manageable but watch closely
  - Action: Use `risk_level="high"` only if Sharpe > 0.8
  
- **> 40%**: Dangerous, kill-switch will trigger
  - Action: Review rug-filter, check market conditions

---

## Migration Path

If you're currently at **Sharpe 0.21**:

1. **Current state**: Using old tight caps (0.3% risk, 10% exposure)
   
2. **Week 1**: Switch to `risk_level="normal"` (0.5% risk, 15% exposure)
   - Expected: Sharpe rises to 0.6–0.65
   - Expected: Avg DD stays 28–35% (within safe zone)
   - Expected: More trades execute, fewer blocks
   
3. **Week 2–3**: Monitor live results, validate edge holds
   - If Sharpe > 0.65 + DD < 35%: Proceed to `"high"`
   - If Sharpe 0.5–0.65: Keep `"normal"` and scale capital
   - If Sharpe < 0.5: Investigate rug-filter accuracy, ML scoring
   
4. **Week 4+**: Once validated with `"normal"`
   - Optionally move to `risk_level="high"` for scaling
   - Or increase bankroll while keeping `"normal"`

---

## Testing & Validation

### Run Stress Tests at All 3 Levels

Use the new `run_risk_tuning_test.py` script:

```bash
python run_risk_tuning_test.py
```

This will:
1. Run robust stress tests with `risk_level="low"`
2. Run robust stress tests with `risk_level="normal"`
3. Run robust stress tests with `risk_level="high"`
4. Output comparison table

Expected output:
```
Risk Level Tuning Results
================================================
Level   | Avg Sharpe | Avg DD% | Avg PnL
--------|----------|---------|----------
low     | 0.32     | 8.5%    | 18,000 SOL
normal  | 0.65     | 31.2%   | 38,000 SOL  ← TARGET
high    | 0.78     | 36.8%   | 44,000 SOL
```

---

## Constraints & Safety

⚠️ **Hard constraints enforced:**

1. **Max per-trade risk**: ≤ 1.0% (can never exceed)
2. **Max total exposure**: ≤ 50% (circuit breaker)
3. **Daily DD kill-switch**: ≤ 40% (hard stop)
4. **Concurrent trades**: ≤ 500 (circuit breaker)
5. **Bankroll floor**: Never allow 0 position sizing

→ These are enforced in `RiskConfig.__post_init__()` and cannot be overridden.

---

## FAQ

**Q: Which level should I start with?**  
A: Use `"low"` for paper trading, then move to `"normal"` for live with real capital.

**Q: Can I change risk_level mid-run?**  
A: No, risk_level is set at bot startup. Restart the bot to change it.

**Q: Will my Sharpe 0.21 go to 0.8 just by changing risk_level?**  
A: No, but it should go to 0.6–0.65. If it doesn't:
   - Check rug-filter accuracy (false rejects?)
   - Review market conditions (regime shift?)
   - Validate ML model training data

**Q: What if I hit survival mode?**  
A: This is normal when rolling Sharpe < 0 for 10+ days. Survival mode:
   - Reduces position sizes
   - Requires higher ML scores (0.65 min vs 0.0)
   - Still allows good trades but blocks weak ones
   - Logs clearly when triggered
   - Automatically disables when rolling metrics recover

**Q: How often should I update risk_level?**  
A: Only when:
   - You've validated performance for 2+ weeks at current level
   - Capital significantly changes (10x+)
   - Market regime shift detected (rug patterns change)

**Q: Can I use "high" risk_level with small bankroll?**  
A: Allowed but not recommended. Position sizing is still capped (1.5–2.0 SOL max), so high level helps more with trade frequency than per-trade size with small capital.

---

## Summary

| Metric | What It Means | What to Do |
|--------|---------------|-----------|
| Sharpe < 0.4 | Edge too weak or too many blocks | Increase risk_level |
| Sharpe 0.6–0.8 | ✅ Target achieved | Keep risk_level, scale capital |
| Sharpe > 1.0 | Excellent, maybe overfitting | Validate on fresh data |
| DD > 40% | Danger zone, kill-switch near | Reduce risk_level or check filters |
| DD 25–35% | ✅ Normal, expected range | Continue with current level |
| Survival mode triggered | Rolling losses detected | Check market conditions, rug-filter |

**Default recommendation: Start with `risk_level="normal"`** after testing with `"low"`.

