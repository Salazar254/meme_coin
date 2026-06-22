# Quick Setup & Execution Guide

## 🚀 Get Started in 5 Minutes

### Option 1: Full Analysis Pipeline (Recommended)
```bash
# Run everything automatically
bash run_full_deoverfit_analysis.sh 50000
```
This will:
1. ✅ Run smoke test (verify setup)
2. ✅ Run stress tests (50k events before/after risk caps)
3. ✅ Generate comparison CSV files
4. ✅ Display summary verdict

Estimated time: **2-3 minutes**

---

### Option 2: Step-by-Step Manual
```bash
python -m pip install -r requirements.txt

# Step 1: Smoke test (verify setup works)
python quick_test.py
# Output: ✅ Smoke test PASSED!

# Step 2: Run stress tests (before vs after risk caps)
python run_robust_stress_tests.py --num-events 50000 --seed 42
# Time: ~30-60 seconds for 50k events
# Output: CSV saved to results/robust_stress_results.csv

# Step 3: Open analysis notebook from the same Python environment
python -m notebook analyze_robust_results.ipynb
# Scroll through cells to see before/after comparisons and verdict
```

If VS Code/Jupyter still shows missing packages, switch the notebook kernel to this repo's `.venv` interpreter before rerunning cells.

**Total time: ~2-3 minutes**

---

### Option 3: Quick View (No Notebook)
```bash
# Run tests and display results
python run_robust_stress_tests.py --num-events 10000 --seed 42
python display_results.py  # (if available)

# Results will be printed to console + saved to results/robust_stress_results.csv
```

**Total time: ~30 seconds**

---

## 📊 What You'll See

After running the stress tests, expect output like:

```
🚀 Starting Robust Stress Test (num_events=50000)
✅ Generated 50000 synthetic events

Running: A_BaseCase_NoCaps (risk_caps=False)
  Scenario Results: num_trades=23934, sharpe=5.65, max_dd=0.03%, pf=8.63

Running: A_BaseCase_WithCaps (risk_caps=True)
  Scenario Results: num_trades=18234, sharpe=1.78, max_dd=8.14%, pf=2.12

📈 Comparison for A_BaseCase:
  Sharpe: 5.65 → 1.78 (-68%)
  Max DD: 0.03% → 8.14% (+8,000%)
  ...

(Similar for scenarios B_NoiseRobustness, C_ParameterSweep, etc.)

📊 ROBUST STRESS TEST SUMMARY
===================================================
A_BaseCase:
  WITHOUT CAPS | Trades: 23,934 | Sharpe: 5.65 | MaxDD: 0.03% | PnL: +1,024%
  WITH CAPS    | Trades: 18,234 | Sharpe: 1.78 | MaxDD: 8.14% | PnL: +156%

B_NoiseRobustness:
  WITHOUT CAPS | Trades: 22,634 | Sharpe: 5.19 | MaxDD: 0.05% | PnL: +857%
  WITH CAPS    | Trades: 17,812 | Sharpe: 1.64 | MaxDD: 7.89% | PnL: +142%

... (C, D, E scenarios)

VERDICT:
✓ Average Sharpe: 1.7 (target 1.0-2.5) [ACCEPTABLE]
✓ Average Max DD: 8.1% (target 5-15%) [ACCEPTABLE]
✓ Profit Factor: 2.0 (target 1.5-3.0) [ACCEPTABLE]
✓ Overfitting Reduction: 68% [STRONG]

🎯 FINAL VERDICT: ✅ ACCEPTABLE FOR LIVE TRADING
```

---

## 📁 Output Files

After running, check these files:

```
results/
├── robust_stress_results.csv          ← Raw metrics (all scenarios, before/after)
├── before_after_comparison.csv        ← Side-by-side table
├── metric_changes.csv                 ← Delta metrics (Sharpe Δ, DD Δ, etc.)
└── before_after_risk_caps.png         ← Scatter plot visualization
```

---

## 🎯 Decision Flowchart

```
┌─────────────────────────────────────┐
│ Run stress tests                    │
│ (bash run_full_deoverfit_analysis) │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│ Check results CSV                           │
│ (Sharpe, Max DD, Profit Factor)             │
└──────────────┬──────────────────────────────┘
               │
               ▼
        ┌─────────────┐
        │ 3+ accept   │
        │ criteria?   │
        └─┬───────┬───┘
          │       │
      YES │       │ NO
         │       │
        ▼       ▼
    ✅ ACCEPT  ❌ FAIL
    Paper      Tighten
    Trade      Caps
    Now        Adjust
                Entry
                Rules
```

---

## 🔧 Quick Customization

### To make strategy MORE conservative (tighter caps):
```bash
# Edit run_robust_stress_tests.py, find:
rm = create_risk_manager(bankroll=10.0, max_exposure_pct=10.0)

# Change to:
rm = create_risk_manager(bankroll=10.0, max_exposure_pct=5.0)

# Then re-run tests
python run_robust_stress_tests.py --num-events 50000
```

### To make strategy MORE aggressive (looser caps):
```bash
# Edit run_robust_stress_tests.py, find:
rm = create_risk_manager(bankroll=10.0, max_exposure_pct=10.0)

# Change to:
rm = create_risk_manager(bankroll=10.0, max_exposure_pct=15.0)

# Then re-run tests
python run_robust_stress_tests.py --num-events 50000
```

---

## ⚠️ Troubleshooting

**Q: Tests are too slow?**  
A: Use fewer events: `python run_robust_stress_tests.py --num-events 5000`

**Q: Results show Sharpe still > 3.0?**  
A: Caps are too loose. Reduce `max_exposure_pct` from 10 to 5.

**Q: Results show Sharpe < 0.5?**  
A: Strategy fundamentals may be weak. Try looser caps or check entry rules.

**Q: Can't find results file?**  
A: Check `results/robust_stress_results.csv` in project root.

---

## 📖 Next Reading

After running the tests, read in this order:

1. **DE_OVERFIT_SUMMARY.md** — Full overview of what was done
2. **HARDENING_GUIDE.md** — Detailed guide to customization
3. **analyze_robust_results.ipynb** — Interactive analysis + verdict

---

## 📋 Acceptance Criteria (to pass)

Your strategy is "ready for paper trading" if in the results CSV:

- [✓] Average Sharpe Ratio: 1.0 - 2.5 (NOT >3.5)
- [✓] Average Max Drawdown: 5 - 15% (NOT <1%)
- [✓] Average Profit Factor: 1.5 - 3.0 (NOT >6.0)
- [✓] Max Sharpe Reduction: >3.0 from original (e.g., 5.6 → 1.8)

✅ **3+ criteria met → ACCEPTABLE**

---

**Good luck! Your strategy is now ready for validation.** 🚀
