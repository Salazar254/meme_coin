"""
backtest/engine.py — Core backtesting engine.

Replays historical events from SQLite, feeds them through the strategy,
simulates trades with slippage/gas, and collects PnL results.
"""

import os
import sys
import time
import logging
from typing import Dict, Any, List, Callable, Optional

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from data.db import get_db
from backtest.metrics import compute_metrics

logger = logging.getLogger("bot.backtest")


class BacktestEngine:
    """
    Event-by-event backtester.

    Usage:
        engine = BacktestEngine(config)
        results = engine.run()                     # uses default strategy
        results = engine.run(strategy_fn=my_fn)    # uses custom strategy function

    The strategy function signature:
        strategy_fn(event: dict, state: dict) -> dict
        Returns: {"action": "BUY"|"SKIP", "amount_sol": float, "reason": str}
    """

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.bt_config = config["backtest"]
        self.strat_config = config["strategy"]

        # Simulation params
        self.initial_bankroll = self.bt_config["initial_bankroll_sol"]
        self.slippage = self.bt_config["slippage"]
        self.gas_cost = self.bt_config["gas_cost_sol"]

        # Strategy params
        self.tp_mult = self.strat_config["take_profit_multiplier"]
        self.sl_frac = self.strat_config["stop_loss_fraction"]
        self.max_positions = self.strat_config["max_open_positions"]

        # DB
        self.db = get_db(config["data"]["db_path"])

    def run(
        self,
        strategy_fn: Optional[Callable] = None,
        start_time: Optional[float] = None,
        end_time: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Run the backtester over historical events.

        Args:
            strategy_fn: Custom strategy function (optional, uses default if None)
            start_time: Unix timestamp to start from (optional)
            end_time: Unix timestamp to end at (optional)

        Returns:
            Dict with trades, equity_curve, and computed metrics.
        """
        # Load events
        events = self.db.get_events(start_time=start_time, end_time=end_time)
        if not events:
            logger.warning("⚠️  No events found in database. Run the feeder first!")
            return {"trades": [], "equity_curve": [], "metrics": {}}

        logger.info(f"📊 Backtesting {len(events)} events…")

        # Use default strategy if none provided
        if strategy_fn is None:
            strategy_fn = self._default_strategy

        return self._simulate(events, strategy_fn)

    def _simulate(
        self, events: List[Dict[str, Any]], strategy_fn: Callable
    ) -> Dict[str, Any]:
        """Core simulation loop."""
        bankroll = self.initial_bankroll
        equity_curve = [{"time": events[0]["timestamp"], "equity": bankroll}]
        trades: List[Dict[str, Any]] = []
        open_positions: List[Dict[str, Any]] = []

        for i, event in enumerate(events):
            ts = event["timestamp"]

            # ── Check exits on open positions ──
            still_open = []
            for pos in open_positions:
                # Use price snapshots to simulate exit
                exit_result = self._check_exit(pos, event)

                if exit_result["closed"]:
                    pnl = exit_result["pnl_sol"]
                    bankroll += pos["amount_sol"] + pnl
                    pos["exit_time"] = ts
                    pos["pnl_sol"] = pnl
                    pos["pnl_pct"] = exit_result["pnl_pct"]
                    pos["status"] = "CLOSED"
                    pos["exit_reason"] = exit_result["reason"]
                    trades.append(pos)
                else:
                    still_open.append(pos)

            open_positions = still_open

            # ── Evaluate new entry ──
            if len(open_positions) < self.max_positions:
                state = {
                    "bankroll": bankroll,
                    "open_positions": len(open_positions),
                    "event_index": i,
                    "total_events": len(events),
                }

                decision = strategy_fn(event, state)

                if decision["action"] == "BUY" and bankroll >= decision["amount_sol"]:
                    amount = decision["amount_sol"]
                    effective = amount * (1 - self.slippage) - self.gas_cost

                    if effective > 0:
                        bankroll -= amount
                        position = {
                            "mint": event.get("mint", "unknown"),
                            "entry_time": ts,
                            "amount_sol": effective,
                            "entry_price": event.get("liquidity_sol", 1.0),
                            "ml_score": decision.get("ml_score"),
                            "reason": decision.get("reason", ""),
                            "slippage": self.slippage,
                            "gas_cost": self.gas_cost,
                            "status": "OPEN",
                        }
                        open_positions.append(position)

            # Record equity
            open_value = sum(p["amount_sol"] for p in open_positions)
            equity_curve.append({"time": ts, "equity": bankroll + open_value})

        # Close any remaining open positions at last known state
        for pos in open_positions:
            pos["status"] = "CLOSED"
            pos["exit_time"] = events[-1]["timestamp"]
            pos["pnl_sol"] = 0.0  # Flat close
            pos["pnl_pct"] = 0.0
            pos["exit_reason"] = "END_OF_DATA"
            bankroll += pos["amount_sol"]
            trades.append(pos)

        # Final equity
        equity_curve.append({
            "time": events[-1]["timestamp"] if events else time.time(),
            "equity": bankroll,
        })

        # Compute metrics
        metrics = compute_metrics(trades, equity_curve, self.initial_bankroll)

        logger.info(f"✅ Backtest complete: {len(trades)} trades, final equity: {bankroll:.4f} SOL")

        return {
            "trades": trades,
            "equity_curve": equity_curve,
            "metrics": metrics,
        }

    def _check_exit(self, position: Dict[str, Any], current_event: Dict[str, Any]) -> Dict[str, Any]:
        """
        Check if a position should be closed based on take-profit or stop-loss.

        Uses the event's price snapshot data (pnl_1m, pnl_5m, etc.) to simulate
        price movement over time.
        """
        entry_price = position.get("entry_price", 1.0)
        if entry_price <= 0:
            return {"closed": False, "pnl_sol": 0, "pnl_pct": 0, "reason": ""}

        # Check available PnL snapshots from the event
        for label_key in ["pnl_10m", "pnl_5m", "pnl_1m"]:
            label_pnl = current_event.get(label_key)
            if label_pnl is not None:
                pnl_pct = label_pnl

                # Take profit
                if pnl_pct >= (self.tp_mult - 1):
                    return {
                        "closed": True,
                        "pnl_sol": position["amount_sol"] * pnl_pct,
                        "pnl_pct": pnl_pct,
                        "reason": f"TP ({label_key}: {pnl_pct*100:.1f}%)",
                    }

                # Stop loss
                if pnl_pct <= -(1 - self.sl_frac):
                    return {
                        "closed": True,
                        "pnl_sol": position["amount_sol"] * pnl_pct,
                        "pnl_pct": pnl_pct,
                        "reason": f"SL ({label_key}: {pnl_pct*100:.1f}%)",
                    }

        # Default: time-based exit (close after ~10 events as proxy for time)
        age = current_event.get("timestamp", 0) - position.get("entry_time", 0)
        if age > 600:  # 10 minutes in seconds
            # Use the best available PnL snapshot or assume flat
            pnl = current_event.get("pnl_10m") or current_event.get("pnl_5m") or 0.0
            return {
                "closed": True,
                "pnl_sol": position["amount_sol"] * pnl,
                "pnl_pct": pnl,
                "reason": f"TIME_EXIT (age={age:.0f}s)",
            }

        return {"closed": False, "pnl_sol": 0, "pnl_pct": 0, "reason": ""}

    # ── Default strategy ──

    def _default_strategy(self, event: Dict[str, Any], state: Dict[str, Any]) -> Dict[str, Any]:
        """
        Simple rule-based sniping strategy.

        Rules:
          1. Buy if LP > min_lp_sol
          2. Buy if unique_buyers >= min_unique_buyers
          3. Position size = default_position_sol (capped by bankroll)
        """
        lp = event.get("liquidity_sol", 0)
        buyers = event.get("unique_buyers", 0)

        if lp < self.strat_config["min_lp_sol"]:
            return {"action": "SKIP", "amount_sol": 0, "reason": f"LP too low ({lp:.2f})"}

        if buyers < self.strat_config["min_unique_buyers"]:
            return {"action": "SKIP", "amount_sol": 0, "reason": f"Few buyers ({buyers})"}

        amount = min(
            self.strat_config["default_position_sol"],
            self.strat_config["max_spend_per_token_sol"],
            state["bankroll"] * 0.1,  # Never risk more than 10% of bankroll
        )

        return {
            "action": "BUY",
            "amount_sol": amount,
            "reason": f"LP={lp:.2f} buyers={buyers}",
            "ml_score": None,
        }
