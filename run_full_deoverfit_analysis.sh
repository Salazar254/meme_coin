#!/bin/bash
# run_full_deoverfit_analysis.sh — End-to-end pipeline for strategy hardening

set -e

echo "════════════════════════════════════════════════════════════════════════════════"
echo "🔧 FULL DE-OVERFIT ANALYSIS PIPELINE"
echo "════════════════════════════════════════════════════════════════════════════════"
echo ""

# Step 1: Smoke test
echo "📋 Step 1: Running smoke test (5K events)..."
python quick_test.py
if [ $? -ne 0 ]; then
    echo "❌ Smoke test failed. Check setup."
    exit 1
fi
echo "✅ Smoke test passed!"
echo ""

# Step 2: Run robust stress tests
echo "📊 Step 2: Running stress tests (before vs after risk caps)..."
echo "   This will test 5 scenarios (A-E) with AND without risk caps."
echo "   Estimated time: 30-60 seconds for 50k events"
echo ""

num_events=50000
if [ ! -z "$1" ]; then
    num_events=$1
    echo "   Using custom event count: $num_events"
fi

python run_robust_stress_tests.py --num-events $num_events --seed 42

if [ $? -ne 0 ]; then
    echo "❌ Stress test failed."
    exit 1
fi
echo "✅ Stress tests completed!"
echo ""

# Step 3: Display results
echo "📈 Step 3: Displaying results summary..."
python display_results.py 2>/dev/null || echo "   (display_results.py not found, skipping)"
echo ""

# Step 4: Open Jupyter
echo "════════════════════════════════════════════════════════════════════════════════"
echo "✅ ANALYSIS COMPLETE"
echo "════════════════════════════════════════════════════════════════════════════════"
echo ""
echo "📊 Next steps:"
echo ""
echo "1. Open Jupyter notebook for detailed analysis:"
echo "   $ jupyter notebook analyze_robust_results.ipynb"
echo ""
echo "2. Review results files:"
echo "   $ ls -lh results/robust_stress_results.csv"
echo "   $ ls -lh results/before_after_comparison.csv"
echo ""
echo "3. Read hardening guide:"
echo "   $ cat HARDENING_GUIDE.md"
echo ""
echo "════════════════════════════════════════════════════════════════════════════════"
