#!/bin/bash
# ─── Run Live Bot ───
# Usage: bash scripts/run_live.sh [DRY_RUN|LIVE]
# Default mode: DRY_RUN (safe, no real trades)

set -e

MODE="${1:-DRY_RUN}"

echo "═══════════════════════════════════════"
echo "  Solana Meme-Coin Bot — ${MODE} Mode"
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
    echo "✅ Loaded config/.env"
else
    echo "⚠️  No config/.env found. Using defaults from config/config.toml."
    echo "   Copy config/.env.example → config/.env and fill in your keys."
fi

# Safety check for LIVE mode
if [ "$MODE" == "LIVE" ]; then
    echo ""
    echo "🔴 WARNING: LIVE MODE — Real money at risk!"
    echo "   Make sure you have:"
    echo "     1. Set WALLET_PRIVATE_KEY or WALLET_KEYPAIR_PATH in .env"
    echo "     2. Tested thoroughly in DRY_RUN mode first"
    echo "     3. Started with a SMALL amount of SOL"
    echo ""
    read -p "   Continue? (yes/no): " confirm
    if [ "$confirm" != "yes" ]; then
        echo "❌ Aborted."
        exit 1
    fi
fi

# Run bot
echo ""
echo "🚀 Starting bot in ${MODE} mode…"
export BOT_MODE="$MODE"

python -c "
from src.bot import SniperBot
bot = SniperBot()
bot.run()
"
