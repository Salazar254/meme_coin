"""
src/strategy_simplified.py — Hardened, simplified sniping strategy

This strategy intentionally sacrifices maximum profitability for robustness:
- Simple 3-rule entry logic (not tuned to historical data)
- Hard position size caps via RiskManager
- No monster-winner concentration
- Focus on consistent small wins and managed drawdown
"""

import logging
from typing import Dict, Any, Optional

logger = logging.getLogger("bot.strategy")


class SimplifiedSniperStrategy:
    """
    Simplified, robust meme-coin sniping strategy.
    
    Entry Rules (all must be satisfied):
    1. Liquidity Pool > 0.5 SOL (conservative, not tuned)
    2. Unique buyers > 8 (real adoption signal, not tuned)
    3. Total time-since-launch < 300 seconds (early entry, not tuned)
    
    Position Sizing:
    - Always request 0.1 SOL base (RiskManager will cap if needed)
    - Rely on RiskManager to enforce hard limits
    
    Exit Logic:
    - Take profit: 2x entry (100% gain)
    - Stop loss: 0.5x entry (50% loss)
    - Let RiskManager handle the math
    
    Design Philosophy:
    - Conservative thresholds (not optimized to 254 historical trades)
    - Multiple simple rules (no complex ML gates concentrating on few winners)
    - Explicit position sizing (no hidden leverage)
    - All parameters documented and justified
    """
    
    # ── Hardened Entry Thresholds ──
    # These are INTENTIONALLY conservative and not fine-tuned
    MIN_LIQUIDITY_SOL = 0.5  # Only launch if LP > 0.5 SOL
    MIN_UNIQUE_BUYERS = 8  # Need some real adoption (not just 1-2 whales)
    MAX_TIME_SINCE_LAUNCH_SEC = 300  # 5 minutes = very early (realistic)
    
    # ── Position Sizing ──
    BASE_POSITION_SOL = 0.1  # Request 0.1 SOL per trade
    # NOTE: RiskManager will reduce this if total exposure would exceed limits
    
    # ── Exit Targets ──
    TAKE_PROFIT_MULTIPLIER = 2.0  # 2x = 100% gain target
    STOP_LOSS_FRACTION = 0.5  # 50% loss cutoff
    
    def __init__(self):
        self.trades_total = 0
        self.trades_entered = 0
        self.trades_skipped = 0
        
    def decide(
        self,
        event: Dict[str, Any],
        state: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Make entry decision based on simple rules.
        
        Args:
            event: Solana event
                {
                    "liquidity_sol": float,
                    "unique_buyers": int,
                    "time_since_launch": float,
                    "timestamp": float,
                    ...
                }
            state: Strategy state
                {
                    "bankroll": float,
                    "open_positions": int,
                    ...
                }
                
        Returns:
            Signal: {"action": "BUY"|"SKIP", "amount_sol": float, "reason": str}
        """
        self.trades_total += 1
        reason = ""
        
        # ── Rule 1: Liquidity threshold ──
        lp = event.get("liquidity_sol", 0)
        if lp < self.MIN_LIQUIDITY_SOL:
            self.trades_skipped += 1
            return {
                "action": "SKIP",
                "amount_sol": 0,
                "reason": f"LP too low ({lp:.2f} < {self.MIN_LIQUIDITY_SOL})",
                "ml_score": None,
            }
        reason += f"LP={lp:.2f}✓ "
        
        # ── Rule 2: Unique buyers threshold ──
        buyers = event.get("unique_buyers", 0)
        if buyers < self.MIN_UNIQUE_BUYERS:
            self.trades_skipped += 1
            return {
                "action": "SKIP",
                "amount_sol": 0,
                "reason": f"Few buyers ({buyers} < {self.MIN_UNIQUE_BUYERS})",
                "ml_score": None,
            }
        reason += f"buyers={buyers}✓ "
        
        # ── Rule 3: Time-since-launch (must be very early) ──
        time_launch = event.get("time_since_launch", float('inf'))
        if time_launch > self.MAX_TIME_SINCE_LAUNCH_SEC:
            self.trades_skipped += 1
            return {
                "action": "SKIP",
                "amount_sol": 0,
                "reason": f"Too late ({time_launch:.0f}s > {self.MAX_TIME_SINCE_LAUNCH_SEC}s)",
                "ml_score": None,
            }
        reason += f"launch_age={time_launch:.0f}s✓"
        
        # ── All rules passed: generate entry signal ──
        self.trades_entered += 1
        return {
            "action": "BUY",
            "amount_sol": self.BASE_POSITION_SOL,
            "reason": reason,
            "ml_score": None,  # No ML-based weighting (was concentrating winners)
        }
    
    def get_stats(self) -> Dict[str, Any]:
        """Return strategy statistics."""
        return {
            "total_evaluations": self.trades_total,
            "signals_sent": self.trades_entered,
            "signals_skipped": self.trades_skipped,
            "entry_rate": self.trades_entered / max(self.trades_total, 1) * 100,
        }
    
    def log_summary(self):
        """Log strategy summary."""
        stats = self.get_stats()
        logger.info(
            f"\n🎯 Strategy Summary:\n"
            f"  Evaluated: {stats['total_evaluations']} events\n"
            f"  Signals Sent: {stats['signals_sent']} (entry_rate={stats['entry_rate']:.1f}%)\n"
            f"  Signals Skipped: {stats['signals_skipped']}\n"
        )


def create_simplified_strategy() -> SimplifiedSniperStrategy:
    """Factory function."""
    return SimplifiedSniperStrategy()
