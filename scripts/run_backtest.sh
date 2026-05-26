#!/bin/bash
# ─── Run Backtester ───
# Usage: bash scripts/run_backtest.sh
# Generates sample data (if needed) and runs the backtester

set -e

echo "═══════════════════════════════════════"
echo "  Solana Meme-Coin Bot — Backtest"
echo "═══════════════════════════════════════"

cd "$(dirname "$0")/.."

# Check if virtual env exists
if [ -d "venv" ]; then
    source venv/bin/activate  2>/dev/null || source venv/Scripts/activate 2>/dev/null
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

# Run backtest
echo "🚀 Running backtest…"
echo ""
python -c "
import toml
from src.bot import SniperBot
import os
os.environ['BOT_MODE'] = 'BACKTEST'
bot = SniperBot()
bot.run()
"

echo ""
echo "✅ Backtest complete!"
echo "   Check data/equity_curve.png for the equity curve."
