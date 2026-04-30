"""
src/bot.py — Main bot engine and mode dispatcher.

Supports three modes:
  BACKTEST  — replay events from local DB
  DRY_RUN   — live event stream, log-only (no real trades)
  LIVE      — live event stream + real trades on Solana mainnet
"""

import os
import sys
import time
import signal
import logging
from typing import Optional

import toml
from dotenv import load_dotenv

# ── Project imports ──
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.log_setup import setup_logging, console
from src.event_handler import EventHandler
from src.trade_sender import TradeSender
from src.wallet import WalletManager
from data.db import get_db

logger = setup_logging()


class SniperBot:
    """
    Main orchestrator.  Depending on `mode`, it either replays
    historical events (backtest) or subscribes to a live Solana feed.
    """

    def __init__(self, config_path: str = "config/config.toml"):
        # ── Load config ──
        load_dotenv("config/.env")
        self.config = toml.load(config_path)

        # Environment overrides
        self.mode = os.getenv("BOT_MODE", self.config["general"]["mode"]).upper()
        self.log_level = os.getenv("LOG_LEVEL", self.config["general"]["log_level"]).upper()

        # ── Adjust log level from config ──
        logging.getLogger().setLevel(self.log_level)

        # ── Core components ──
        db_path = self.config["data"]["db_path"]
        self.db = get_db(db_path)
        self.event_handler = EventHandler(self.config)
        self.trade_sender = TradeSender(self.config, mode=self.mode)
        self.wallet: Optional[WalletManager] = None

        if self.mode == "LIVE":
            self.wallet = WalletManager()

        # ── Graceful shutdown ──
        self._running = True
        signal.signal(signal.SIGINT, self._shutdown)
        signal.signal(signal.SIGTERM, self._shutdown)

        logger.info(f"🤖 SniperBot initialized | mode={self.mode}")

    def _shutdown(self, signum, frame):
        logger.info("🛑 Shutdown signal received — stopping gracefully…")
        self._running = False

    # ── Entry point ──

    def run(self):
        """Dispatch to the correct run loop based on mode."""
        console.print(f"\n[bold green]🚀 Starting bot in {self.mode} mode[/bold green]\n")

        if self.mode == "BACKTEST":
            self._run_backtest()
        elif self.mode in ("DRY_RUN", "LIVE"):
            self._run_live()
        else:
            logger.error(f"Unknown mode: {self.mode}")
            sys.exit(1)

    # ── Backtest loop ──

    def _run_backtest(self):
        """Replay stored events through the strategy."""
        from backtest.engine import BacktestEngine

        engine = BacktestEngine(self.config)
        results = engine.run()

        # Print summary
        from backtest.metrics import print_metrics
        print_metrics(results)

    # ── Live / DryRun loop ──

    def _run_live(self):
        """Subscribe to Solana events and process in real time."""
        import asyncio

        async def _loop():
            rpc_url = os.getenv("SOLANA_RPC_URL", self.config["solana"]["rpc_url"])
            ws_url = os.getenv("SOLANA_WS_URL", self.config["solana"]["ws_url"])

            logger.info(f"📡 Connecting to RPC: {rpc_url}")
            logger.info(f"📡 WebSocket: {ws_url}")

            # Restore any open positions from a previous run
            self.trade_sender.restore_open_positions()
            if self.trade_sender.open_positions:
                logger.info(
                    f"♻️  Restored {len(self.trade_sender.open_positions)} "
                    f"open positions from database"
                )

            # Log wallet balance on start
            if self.wallet and self.wallet.public_key:
                balance = await self.wallet.get_balance(rpc_url)
                logger.info(f"💰 Wallet balance: {balance:.4f} SOL")

            # Poll-based loop (can be upgraded to WebSocket subscription)
            poll_interval = self.config["data"]["poll_interval_seconds"]
            position_check_interval = 30  # Check exits every 30 seconds
            last_position_check = 0

            while self._running:
                try:
                    # ── Fetch new events from RPC ──
                    new_events = await self.event_handler.fetch_new_events(rpc_url)

                    for event in new_events:
                        # Store in DB
                        self.db.insert_event(event)

                        # Run strategy
                        decision = self.event_handler.evaluate(event)

                        if decision["action"] == "BUY":
                            trade_result = self.trade_sender.execute(
                                event=event,
                                decision=decision,
                                wallet=self.wallet,
                            )
                            logger.info(
                                f"{'📝' if self.mode == 'DRY_RUN' else '💰'} "
                                f"Trade: {trade_result}"
                            )

                    # ── Periodically check open positions for exits ──
                    now = time.time()
                    if (
                        now - last_position_check > position_check_interval
                        and self.trade_sender.open_positions
                    ):
                        last_position_check = now
                        await self._check_position_exits()

                    await asyncio.sleep(poll_interval)

                except Exception as e:
                    logger.error(f"❌ Error in live loop: {e}", exc_info=True)
                    if self.config["vps"]["restart_on_error"]:
                        await asyncio.sleep(self.config["vps"]["restart_delay_seconds"])
                    else:
                        break

        asyncio.run(_loop())

    async def _check_position_exits(self):
        """
        Monitor open positions and execute exits when TP/SL is hit.

        In LIVE mode, fetches real token prices via Jupiter and
        executes sell transactions. In DRY_RUN, logs what would happen.
        """
        if not self.trade_sender.open_positions:
            return

        tp = self.config["strategy"]["take_profit_multiplier"]
        sl = self.config["strategy"]["stop_loss_fraction"]
        to_close = []

        for mint, position in list(self.trade_sender.open_positions.items()):
            current_price = 0.0

            if self.mode == "LIVE" and self.wallet:
                # Get real price from Jupiter
                current_price = await self.wallet.get_token_price_sol(mint)
            elif self.mode == "DRY_RUN":
                # In dry-run, simulate price movement
                age = time.time() - position.get("entry_time", time.time())
                # Simple random walk for dry-run monitoring
                import random
                current_price = position.get("price", 1.0) * (1 + random.uniform(-0.3, 0.5))

            if current_price <= 0:
                continue

            entry_price = position.get("price", current_price)
            if entry_price <= 0:
                continue

            pnl_pct = (current_price - entry_price) / entry_price

            # Take profit
            if pnl_pct >= (tp - 1):
                logger.info(
                    f"🎯 TP hit on {mint[:12]}… | "
                    f"PnL: +{pnl_pct*100:.1f}% | "
                    f"Price: {entry_price:.6f} → {current_price:.6f}"
                )
                to_close.append((mint, pnl_pct, "TAKE_PROFIT"))

            # Stop loss
            elif pnl_pct <= -(1 - sl):
                logger.info(
                    f"🛑 SL hit on {mint[:12]}… | "
                    f"PnL: {pnl_pct*100:.1f}% | "
                    f"Price: {entry_price:.6f} → {current_price:.6f}"
                )
                to_close.append((mint, pnl_pct, "STOP_LOSS"))

            # Time-based exit (close after 10 minutes)
            elif time.time() - position.get("entry_time", 0) > 600:
                logger.info(
                    f"⏰ Time exit on {mint[:12]}… | "
                    f"PnL: {pnl_pct*100:+.1f}% (held >10min)"
                )
                to_close.append((mint, pnl_pct, "TIME_EXIT"))

        # ── Execute exits ──
        for mint, pnl_pct, reason in to_close:
            pos = self.trade_sender.open_positions.pop(mint, None)
            if not pos:
                continue

            pnl_sol = pos["amount_sol"] * pnl_pct

            # Execute sell in LIVE mode
            if self.mode == "LIVE" and self.wallet:
                try:
                    token_balance = await self.wallet.get_token_balance(mint)
                    if token_balance > 0:
                        decimals = pos.get("decimals", 6)
                        raw_amount = int(token_balance * (10 ** decimals))
                        tx_sig = self.wallet.send_sell(
                            mint_address=mint,
                            token_amount=raw_amount,
                            token_decimals=decimals,
                            slippage_bps=300,
                        )
                        logger.info(f"✅ SELL executed: {tx_sig} | Reason: {reason}")
                except Exception as e:
                    logger.error(f"❌ SELL failed for {mint[:12]}…: {e}")
            else:
                logger.info(
                    f"📝 [DRY_RUN] Would SELL {mint[:12]}… | "
                    f"PnL: {pnl_pct*100:+.1f}% ({pnl_sol:+.4f} SOL) | Reason: {reason}"
                )

            # Update DB
            if pos.get("id"):
                self.db.close_trade(pos["id"], time.time(), pnl_sol, pnl_pct)


# ── CLI entry point ──

def main():
    import click

    @click.command()
    @click.option("--config", default="config/config.toml", help="Path to config file")
    @click.option("--mode", default=None, help="Override mode: BACKTEST|DRY_RUN|LIVE")
    def cli(config, mode):
        """Solana Meme-Coin Sniping Bot"""
        if mode:
            os.environ["BOT_MODE"] = mode
        bot = SniperBot(config_path=config)
        bot.run()

    cli()


if __name__ == "__main__":
    main()
