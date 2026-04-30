#!/bin/bash
# run_stress_tests.sh — Quick runner for scenario stress tests

set -e

echo "═══════════════════════════════════════════════════════════"
echo "  Meme-Coin Strategy: Stress-Test Framework"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Configuration
NUM_EVENTS="${1:-100000}"
SCENARIOS="${2:-A,B,C,D,E}"
SEED=42
OUTPUT="results/scenario_results.csv"

echo "📋 Configuration:"
echo "  Events: $NUM_EVENTS"
echo "  Scenarios: $SCENARIOS"
echo "  Seed: $SEED"
echo "  Output: $OUTPUT"
echo ""

# Create results directory
mkdir -p results

# Run stress tests
echo "🚀 Running stress tests…"
echo ""
python run_million_scenario_tests.py \
  --num-events "$NUM_EVENTS" \
  --scenarios "$SCENARIOS" \
  --seed "$SEED" \
  --output "$OUTPUT"

echo ""
echo "✅ Stress tests complete!"
echo ""
echo "📊 Next steps:"
echo "  1. View results: cat $OUTPUT"
echo "  2. Analyze in Jupyter: jupyter notebook analyze_scenario_results.ipynb"
echo "  3. Check charts: ls -lh results/*.png"
echo ""
