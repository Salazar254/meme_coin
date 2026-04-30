#!/bin/bash
# ─── Run Event Feeder ───
# Usage: bash scripts/run_feeder.sh [--generate-sample N]

set -e

echo "═══════════════════════════════════════"
echo "  Solana Meme-Coin Bot — Event Feeder"
echo "═══════════════════════════════════════"

cd "$(dirname "$0")/.."

# Check if virtual env exists
if [ -d "venv" ]; then
    source venv/bin/activate 2>/dev/null || source venv/Scripts/activate 2>/dev/null
fi

# Load .env
if [ -f "config/.env" ]; then
    set -a
    source config/.env
    set +a
fi

# Parse args
if [[ "$1" == "--generate-sample" ]]; then
    COUNT="${2:-500}"
    echo "🎲 Generating $COUNT synthetic events…"
    python feeder.py --generate-sample "$COUNT"
else
    echo "📡 Starting live event ingestion…"
    echo "   Press Ctrl+C to stop"
    echo ""
    python feeder.py --db data/events.db
fi
