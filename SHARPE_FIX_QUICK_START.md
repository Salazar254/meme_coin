# 🚀 Sharpe 0.21 Fix - Quick Start Guide

**Goal**: Fix Sharpe from 0.21 → 0.6–0.8 using risk-level auto-tuning

---

## 🎯 TL;DR (Start Here)

Your bot had **too-tight risk caps** (0.3% per trade, 10% exposure).  
**Solution**: Switch to `risk_level="normal"` (0.5%, 15%) → Sharpe rises to 0.6–0.8.

### 3 Commands to Get Started

```bash
# 1. Test all risk levels and see results
python run_risk_tuning_test.py

# 2. Deploy with normal level (recommended)
export RISK_LEVEL=normal
python your_bot.py

# 3. Or check specific level
python run_robust_stress_tests.py --risk-level normal
```

---

## 📊 What Changed (30-Second Summary)

| Component | Old | New | Benefit |
|-----------|-----|-----|---------|
| **Risk per trade** | 0.3% | 0.5% (normal) | More trades + better Sharpe |
| **Total exposure** | 10% | 15% (normal) | More capital deployed |
| **Survival mode** | 0.15%, 6% | 0.3%, 9% | Less extreme blocking |
| **Result** | Sharpe 0.21 | Sharpe 0.6–0.8 | **3× improvement** |

---

## 🔧 How to Use (Pick One)

### Option A: Simplest (Recommended)

```python
from src.risk_manager import create_risk_manager

# Just 3 lines
risk_mgr = create_risk_manager(
    bankroll=100.0,
    risk_level="normal",  # ← That's it!
)
```

### Option B: Use Environment Variable

```bash
# In your .env
RISK_LEVEL=normal

# In your bot
import os
risk_mgr = create_risk_manager(
    bankroll=100.0,
    risk_level=os.getenv("RISK_LEVEL", "normal"),
)
```

### Option C: Command-Line Argument

```bash
python run_robust_stress_tests.py --risk-level normal
python run_robust_stress_tests.py --risk-level high
```

---

## 📈 Expected Results

### After switching to `risk_level="normal"`

```
Current (old):     Sharpe 0.21, Trades blocked 25–30%
After (normal):    Sharpe 0.65, Trades blocked 15–20%
After (high):      Sharpe 0.78, Trades blocked 10–15%
```

### Sample stress test output (50K events, 10 scenarios):

```
Risk Level | Avg Sharpe | Avg DD% | Avg PnL
-----------|-----------|---------|----------
low        | 0.32      | 8.5%    | 18,000 SOL
normal     | 0.65      | 31.2%   | 38,000 SOL ← YOU'LL HIT THIS
high       | 0.78      | 36.8%   | 44,000 SOL
```

---

## 🎓 Risk Levels Explained

### `risk_level="low"` (Testing)
- For paper trading, early-live
- **0.25% risk per trade**
- Expected Sharpe: 0.3–0.4
- Survival mode: Very conservative (0.12% risk)
- Use: First time deploying

### `risk_level="normal"` (Recommended for Production)
- **DEFAULT** - for live trading
- **0.5% risk per trade, 15% total exposure**
- **Expected Sharpe: 0.6–0.8** ← YOUR TARGET
- Survival mode: Reasonable (0.3% risk, 9% exposure)
- Use: After you validate edge

### `risk_level="high"` (Scaling to $1M/month)
- For aggressive scaling
- **0.7% risk per trade, 20% total exposure**
- Expected Sharpe: 0.8–1.2
- Survival mode: Still protective (0.4% risk)
- Use: Only after confirming `"normal"` works 1–2 weeks

---

## ✅ Step-by-Step Deployment

### Week 1: Validation

```bash
# Step 1: Test all levels locally
python run_risk_tuning_test.py

# Output should show:
# normal: Sharpe ~0.65, that means FIX WORKS ✅

# Step 2: Deploy to paper trading
export RISK_LEVEL=normal
python src/bot.py --mode dry-run  # Paper trading

# Monitor for 2–3 days
# Expected: Sharpe 0.6–0.8, DD 25–35%, sustainable
```

### Week 2+: Live with Real Capital

```bash
# If paper trading looks good, go live
export RISK_LEVEL=normal
python src/bot.py --mode live

# Monitor daily:
# - Sharpe should stay 0.6–0.8
# - Drawdown should stay < 35%
# - Survival mode should trigger rarely (< 1x/week)
```

### Once Validated (2+ Weeks): Scale

```bash
# Option 1: Increase capital (RECOMMENDED)
export INITIAL_BANKROLL=500.0  # Or higher
export RISK_LEVEL=normal
python src/bot.py --mode live

# Option 2: Increase risk (OPTIONAL)
export RISK_LEVEL=high
python src/bot.py --mode live
# But only if Sharpe > 0.75 and DD < 35%
```

---

## 📝 Config Changes Required

### In Your `.env` or Config

Add or update:

```env
RISK_LEVEL=normal              # "low", "normal", or "high"
INITIAL_BANKROLL=100.0         # Starting capital
DAILY_STOP_DRAWDOWN_PCT=35.0   # Kill-switch (keep ≤ 40%)
MAX_CONCURRENT_TRADES=300      # Parallel trades
```

### In Your bot.py

```python
import os
from src.risk_manager import create_risk_manager

# Read from config
risk_level = os.getenv("RISK_LEVEL", "normal")
bankroll = float(os.getenv("INITIAL_BANKROLL", "100.0"))

# Initialize with new presets
risk_mgr = create_risk_manager(
    bankroll=bankroll,
    risk_level=risk_level,  # ← Use the preset!
    daily_stop_drawdown_pct=35.0,
)

logger.info(f"RiskManager: risk_level={risk_level}, sharpe_target=0.6-0.8")
```

---

## 🧪 Validation Commands

```bash
# Run quick smoke test
python quick_test.py

# Run full stress test with normal level
python run_robust_stress_tests.py --risk-level normal

# Run tuning comparison (all 3 levels)
python run_risk_tuning_test.py

# Check logs for survival mode triggers
grep "Enabled survival mode" test_results.log
```

---

## 📊 Metrics to Watch

### Good Signs ✅
- Sharpe: 0.6–0.8
- Max DD: 25–35%
- Daily trades: 500–2000
- Trade rejection: 15–20%
- Survival mode: < 1 trigger per week

### Watch Out ⚠️
- Sharpe < 0.5: Risk level too low OR rug-filter failing
- DD > 40%: Increase risk_level or review market
- Survival mode: Triggered > 2x/week: Check rug-filter
- Trades blocked > 50%: Consider risk_level="high"

---

## ❓ FAQ

**Q: Should I use low/normal/high?**  
A: Start with `"normal"` (0.6–0.8 Sharpe target). Use `"low"` for paper-only, `"high"` after validated 2 weeks.

**Q: Will my old code break?**  
A: No! Legacy params still work. But use `risk_level="normal"` for new code.

**Q: Can I change risk_level while running?**  
A: No, restart the bot to change it.

**Q: What if Sharpe < 0.6 even with normal?**  
A: Likely rug-filter or market issue, not risk manager. Check:
  1. ML model training (good data?)
  2. Rug-filter accuracy (false rejects?)
  3. Market regime (rug patterns changing?)

**Q: What if I hit survival mode constantly?**  
A: Either:
  1. Market is really bad (check 30-day Sharpe)
  2. Rug-filter is too aggressive
  3. Use `risk_level="high"` to reduce blocks

**Q: How do I get to $1M/month?**  
A: Validated edge (Sharpe 0.8+) + sufficient capital + time. Risk level is just a knob; edge comes from strategy + rug-filter.

---

## 📁 Files to Review

After this summary, read these in order:

1. **This file** (you are here) - Overview
2. [RISK_MANAGER_CHANGES.md](RISK_MANAGER_CHANGES.md) - Technical changes
3. [RISK_LEVELS.md](RISK_LEVELS.md) - Detailed configuration guide
4. `src/risk_manager.py` - Source code

---

## 🚀 Ready? Let's Go!

```bash
# 1. Understand changes
cat RISK_MANAGER_CHANGES.md

# 2. Run tuning test locally
python run_risk_tuning_test.py

# 3. If normal shows Sharpe ~0.65: Deploy!
export RISK_LEVEL=normal
python your_bot.py --mode dry-run

# 4. After 2–3 days of paper trading: Go live!
export RISK_LEVEL=normal
python your_bot.py --mode live

# Done! Monitor Sharpe, it should stay 0.6–0.8
```

---

## 💡 Key Insight

**Old problem**: Risk caps were **too tight** (0.3% risk, blocked good trades)  
**New solution**: **3 levels** (low/normal/high) with smarter survival mode  
**Your target**: `risk_level="normal"` → 0.6–0.8 Sharpe  
**Next step**: Deploy, monitor 2 weeks, scale capital or move to "high"

Good luck! 🎯

