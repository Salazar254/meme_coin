"""
feeder.py — Solana event ingestion CLI.

Connects to a Solana RPC endpoint and continuously ingests new token
launch events (Pump.fun, Raydium, etc.) into the local SQLite database.

Usage:
    python feeder.py                          # Use config defaults
    python feeder.py --rpc https://...        # Override RPC URL
    python feeder.py --source pumpfun         # Filter by source
    python feeder.py --generate-sample 500    # Generate synthetic sample data
"""

import os
import sys
import time
import asyncio
import logging
import random
from typing import Optional

import click
from dotenv import load_dotenv

# Project imports — use centralized UTF-8-safe logging
from src.log_setup import setup_logging, console
from data.db import get_db

logger = setup_logging("INFO")

# ── Known program IDs ──
PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"


async def ingest_from_rpc(rpc_url: str, db_path: str, poll_interval: float = 2.0):
    """
    Poll the Solana RPC for new Pump.fun-style token launches and store them.
    """
    import httpx

    db = get_db(db_path)
    seen_sigs: set = set()

    logger.info(f"📡 Starting feeder → {rpc_url}")
    logger.info(f"💾 Database: {db_path}")
    logger.info(f"⏱️  Poll interval: {poll_interval}s")

    while True:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                payload = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "getSignaturesForAddress",
                    "params": [
                        PUMPFUN_PROGRAM,
                        {"limit": 50, "commitment": "confirmed"},
                    ],
                }
                resp = await client.post(rpc_url, json=payload)
                data = resp.json()

                if "error" in data:
                    logger.warning(f"RPC error: {data['error']}")
                    await asyncio.sleep(poll_interval)
                    continue

                results = data.get("result", [])
                new_count = 0

                for sig_info in results:
                    sig = sig_info.get("signature", "")
                    if sig in seen_sigs:
                        continue

                    seen_sigs.add(sig)
                    new_count += 1

                    # Parse and store event
                    event = {
                        "mint": sig[:44],  # simplified — real parser decodes tx
                        "timestamp": sig_info.get("blockTime", time.time()),
                        "block_slot": sig_info.get("slot", 0),
                        "tx_signature": sig,
                        "liquidity_sol": 0.0,
                        "unique_buyers": 0,
                        "total_volume": 0.0,
                        "token_name": "PENDING",
                        "token_symbol": "?",
                        "source": "pumpfun",
                    }

                    db.insert_event(event)

                if new_count > 0:
                    total = db.get_event_count()
                    logger.info(f"📦 Ingested {new_count} new events (total: {total})")

        except Exception as e:
            logger.error(f"❌ Feeder error: {e}", exc_info=True)

        await asyncio.sleep(poll_interval)


def generate_sample_data(db_path: str, count: int = 500):
    """
    Generate synthetic sample data for local backtesting.

    Creates realistic-looking Pump.fun events with randomized stats,
    including price snapshots and PnL labels for ML training.
    """
    db = get_db(db_path)

    logger.info(f"🎲 Generating {count} synthetic events…")

    base_time = time.time() - (count * 60)  # Start from count minutes ago
    token_names = [
        "DOGE2", "PEPE", "BONK", "WIF", "MYRO", "POPCAT", "BRETT", "MEW",
        "BOME", "SLERF", "TREMP", "HARAMBE", "MOTHER", "DADDY", "GIGA",
        "MOODENG", "PNUT", "ACT", "GOAT", "FWOG", "CHILLGUY", "AI16Z",
        "GRIFFAIN", "VINE", "MELANIA", "JELLYJELLY", "MUBARAK",
    ]

    for i in range(count):
        # Simulate realistic token launch patterns
        ts = base_time + (i * random.uniform(30, 120))

        # Most tokens have small LP; some are larger
        lp_sol = random.choice([
            random.uniform(0.1, 0.5),   # 40% tiny
            random.uniform(0.5, 2.0),   # 30% small
            random.uniform(2.0, 10.0),  # 20% medium
            random.uniform(10.0, 100.0),  # 10% large
        ])

        buyers = random.randint(0, max(1, int(lp_sol * 3)))

        # Price movement follows power law — most tokens die, few moon
        r = random.random()
        if r < 0.6:
            # 60% lose value
            pnl_1m = random.uniform(-0.9, -0.1)
            pnl_5m = pnl_1m * random.uniform(0.8, 1.5)
            pnl_10m = pnl_5m * random.uniform(0.8, 1.5)
        elif r < 0.85:
            # 25% break even or small gain
            pnl_1m = random.uniform(-0.2, 0.5)
            pnl_5m = random.uniform(-0.3, 0.8)
            pnl_10m = random.uniform(-0.4, 1.0)
        elif r < 0.95:
            # 10% good gains (2-10x)
            pnl_1m = random.uniform(0.5, 2.0)
            pnl_5m = random.uniform(1.0, 5.0)
            pnl_10m = random.uniform(2.0, 9.0)
        else:
            # 5% moonshot (10x+)
            pnl_1m = random.uniform(2.0, 5.0)
            pnl_5m = random.uniform(5.0, 20.0)
            pnl_10m = random.uniform(9.0, 99.0)

        name = random.choice(token_names) + str(random.randint(1, 9999))

        event = {
            "mint": f"{''.join(random.choices('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz123456789', k=44))}",
            "timestamp": ts,
            "block_slot": int(ts * 2),
            "tx_signature": f"{''.join(random.choices('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz123456789', k=88))}",
            "liquidity_sol": round(lp_sol, 4),
            "liquidity_usd": round(lp_sol * 150, 2),  # ~$150/SOL
            "unique_buyers": buyers,
            "total_volume": round(lp_sol * random.uniform(0.5, 5.0), 4),
            "market_cap_sol": round(lp_sol * random.uniform(1, 10), 4),
            "token_name": name,
            "token_symbol": name[:4].upper(),
            "source": "pumpfun",
            "pnl_1m": round(pnl_1m, 4),
            "pnl_5m": round(pnl_5m, 4),
            "pnl_10m": round(pnl_10m, 4),
            "is_10x": 1 if pnl_10m >= 9.0 else 0,
            "is_100x": 1 if pnl_10m >= 99.0 else 0,
        }

        db.insert_event(event)

    total = db.get_event_count()
    logger.info(f"✅ Generated {count} synthetic events (total in DB: {total})")
    logger.info(f"💾 Database: {db_path}")


@click.command()
@click.option("--rpc", default=None, help="Solana RPC URL (overrides config)")
@click.option("--db", default="data/events.db", help="Database path")
@click.option("--source", default="pumpfun", help="Event source to track")
@click.option("--interval", default=2.0, help="Poll interval (seconds)")
@click.option("--generate-sample", default=0, type=int, help="Generate N synthetic events for testing")
def main(rpc, db, source, interval, generate_sample):
    """Solana meme-coin event feeder / data ingestion."""
    load_dotenv("config/.env")

    if generate_sample > 0:
        generate_sample_data(db, generate_sample)
        return

    rpc_url = rpc or os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")

    try:
        asyncio.run(ingest_from_rpc(rpc_url, db, interval))
    except KeyboardInterrupt:
        logger.info("🛑 Feeder stopped.")


if __name__ == "__main__":
    main()
