#!/bin/bash
# ─── Run ML Training Pipeline ───
# Usage: bash scripts/run_train.sh [--walk-forward]

set -e

echo "═══════════════════════════════════════"
echo "  Solana Meme-Coin Bot — ML Training"
echo "═══════════════════════════════════════"

cd "$(dirname "$0")/.."

# Check if virtual env exists
if [ -d "venv" ]; then
    source venv/bin/activate 2>/dev/null || source venv/Scripts/activate 2>/dev/null
fi

# Check if database has events
EVENT_COUNT=$(python -c "
from data.db import get_db
db = get_db('data/events.db')
print(db.get_event_count())
" 2>/dev/null || echo "0")

if [ "$EVENT_COUNT" -lt "50" ]; then
    echo ""
    echo "📊 Database has $EVENT_COUNT events. Generating 500 synthetic samples…"
    python feeder.py --generate-sample 500
    echo ""
fi

# Parse arguments
EXTRA_ARGS=""
if [[ "$1" == "--walk-forward" ]]; then
    EXTRA_ARGS="--walk-forward"
    echo "📈 Walk-forward training mode"
fi

# Run training
echo "🧠 Starting ML training pipeline…"
echo ""
python -m ml.train --db data/events.db --target pnl_5m --threshold 0.5 --epochs 50 $EXTRA_ARGS

echo ""
echo "✅ Training complete!"
echo "   Models saved to ml/saved_models/"
echo "   Plots saved to data/"
