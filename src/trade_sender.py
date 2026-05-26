"""
src/trade_sender.py — Trade execution layer.

Handles trade execution across all modes:
  BACKTEST  → simulated (no-op, returns mock result)
  DRY_RUN   → logs what would happen without sending tx
  LIVE      → signs and sends real Solana transactions
"""

import os
import sys
import time
import logging
from typing import Dict, Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from data.db import get_db

logger = logging.getLogger("bot.trade_sender")


class TradeSender:
    """
    Execute trades based on strategy decisions.
    The mode determines whether trades are real, logged, or simulated.
    """

    def __init__(self, config: Dict[str, Any], mode: str = "BACKTEST"):
        self.config = config
        self.mode = mode.upper()
        self.db = get_db(config["data"]["db_path"])

        # Track open positions
        self.open_positions: Dict[str, Dict[str, Any]] = {}

        # Position limits
        self.max_open = config["strategy"]["max_open_positions"]

    def execute(
        self,
        event: Dict[str, Any],
        decision: Dict[str, Any],
        wallet=None,
    ) -> Dict[str, Any]:
        """
        Execute a trade decision. Returns a result dict with trade details.

        Args:
            event: The event that triggered this trade
            decision: Strategy decision (action, amount, reason, ml_score)
            wallet: WalletManager instance (required for LIVE mode)
        """
        if decision["action"] != "BUY":
            return {"status": "SKIPPED", "reason": decision["reason"]}

        # Check position limits
        if len(self.open_positions) >= self.max_open:
            return {"status": "SKIPPED", "reason": f"Max open positions ({self.max_open}) reached"}

        mint = event.get("mint", "unknown")
        amount_sol = decision["amount_sol"]

        # ── Route by mode ──
        if self.mode == "BACKTEST":
            return self._execute_backtest(event, amount_sol, decision)
        elif self.mode == "DRY_RUN":
            return self._execute_dry_run(event, amount_sol, decision)
        elif self.mode == "LIVE":
            return self._execute_live(event, amount_sol, decision, wallet)
        else:
            return {"status": "ERROR", "reason": f"Unknown mode: {self.mode}"}

    # ── Backtest execution (simulated) ──

    def _execute_backtest(
        self, event: Dict[str, Any], amount_sol: float, decision: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Simulate a trade using backtest slippage/gas parameters."""
        slippage = self.config["backtest"]["slippage"]
        gas = self.config["backtest"]["gas_cost_sol"]

        effective_amount = amount_sol * (1 - slippage) - gas

        trade = {
            "event_id": event.get("id"),
            "mint": event.get("mint", "unknown"),
            "mode": "BACKTEST",
            "side": "BUY",
            "amount_sol": effective_amount,
            "price": event.get("liquidity_sol", 1.0),  # simplified
            "slippage": slippage,
            "gas_cost": gas,
            "entry_time": event.get("timestamp", time.time()),
            "ml_score": decision.get("ml_score"),
            "strategy_name": "rule_based",
            "status": "OPEN",
        }

        # Track position
        self.open_positions[trade["mint"]] = trade

        # Store in DB
        trade_id = self.db.insert_trade(trade)
        trade["id"] = trade_id

        return {
            "status": "FILLED",
            "mode": "BACKTEST",
            "mint": trade["mint"],
            "amount_sol": effective_amount,
            "trade_id": trade_id,
        }

    # ── Dry run (log only) ──

    def _execute_dry_run(
        self, event: Dict[str, Any], amount_sol: float, decision: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Log what would have been traded, but don't send anything."""
        trade = {
            "event_id": event.get("id"),
            "mint": event.get("mint", "unknown"),
            "mode": "DRY_RUN",
            "side": "BUY",
            "amount_sol": amount_sol,
            "price": event.get("liquidity_sol", 1.0),
            "slippage": 0.0,
            "gas_cost": 0.0,
            "entry_time": time.time(),
            "ml_score": decision.get("ml_score"),
            "strategy_name": "rule_based",
            "status": "SIMULATED",
        }

        trade_id = self.db.insert_trade(trade)

        logger.info(
            f"[DRY_RUN] Would BUY {amount_sol:.4f} SOL of {trade['mint'][:12]}… "
            f"| ML score: {decision.get('ml_score', 'N/A')} | Reason: {decision['reason']}"
        )

        return {
            "status": "DRY_RUN",
            "mint": trade["mint"],
            "amount_sol": amount_sol,
            "trade_id": trade_id,
        }

    # ── Live execution ──

    def _execute_live(
        self,
        event: Dict[str, Any],
        amount_sol: float,
        decision: Dict[str, Any],
        wallet=None,
    ) -> Dict[str, Any]:
        """
        Send a real swap transaction on Solana mainnet.

        ⚠️  This is the dangerous path — uses real SOL from your wallet.
        Start with tiny amounts on devnet first!
        """
        if wallet is None:
            return {"status": "ERROR", "reason": "No wallet configured for LIVE mode"}

        mint = event.get("mint", "unknown")
        logger.info(f"🔴 [LIVE] Executing BUY: {amount_sol:.4f} SOL → {mint[:12]}…")

        try:
            # Build and send the swap transaction
            # This is a simplified placeholder — in production, you'd use
            # Jupiter or Raydium SDK for the actual swap
            tx_sig = wallet.send_swap(
                mint_address=mint,
                amount_sol=amount_sol,
                slippage_bps=int(self.config["backtest"]["slippage"] * 10000),
            )

            trade = {
                "event_id": event.get("id"),
                "mint": mint,
                "mode": "LIVE",
                "side": "BUY",
                "amount_sol": amount_sol,
                "entry_time": time.time(),
                "ml_score": decision.get("ml_score"),
                "strategy_name": "rule_based",
                "tx_signature": tx_sig,
                "status": "OPEN",
            }

            trade_id = self.db.insert_trade(trade)
            self.open_positions[mint] = trade

            logger.info(f"✅ [LIVE] Trade sent: {tx_sig}")

            return {
                "status": "FILLED",
                "mode": "LIVE",
                "mint": mint,
                "amount_sol": amount_sol,
                "tx_signature": tx_sig,
                "trade_id": trade_id,
            }

        except Exception as e:
            logger.error(f"❌ [LIVE] Trade failed: {e}", exc_info=True)
            return {"status": "FAILED", "reason": str(e)}

    # ── Position management ──

    def check_exits(self, current_prices: Dict[str, float]):
        """
        Check all open positions against take-profit / stop-loss.
        Called periodically in the live loop.
        """
        tp = self.config["strategy"]["take_profit_multiplier"]
        sl = self.config["strategy"]["stop_loss_fraction"]
        to_close = []

        for mint, position in self.open_positions.items():
            if mint not in current_prices:
                continue

            current = current_prices[mint]
            entry = position.get("price", current)

            if entry <= 0:
                continue

            pnl_pct = (current - entry) / entry

            # Take profit
            if pnl_pct >= (tp - 1):
                logger.info(f"🎯 TP hit on {mint[:12]}… | PnL: +{pnl_pct*100:.1f}%")
                to_close.append((mint, pnl_pct))

            # Stop loss
            elif pnl_pct <= -(1 - sl):
                logger.info(f"🛑 SL hit on {mint[:12]}… | PnL: {pnl_pct*100:.1f}%")
                to_close.append((mint, pnl_pct))

        for mint, pnl_pct in to_close:
            pos = self.open_positions.pop(mint, None)
            if pos and pos.get("id"):
                pnl_sol = pos["amount_sol"] * pnl_pct
                self.db.close_trade(pos["id"], time.time(), pnl_sol, pnl_pct)
