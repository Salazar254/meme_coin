"""
src/risk_manager.py - Hard risk management, survival mode, and live guardrails.
"""

from __future__ import annotations

import logging
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Literal, Optional

logger = logging.getLogger("bot.risk")


@dataclass(frozen=True)
class RiskModeCaps:
    name: str
    max_risk_per_trade_pct: float
    max_total_exposure_pct: float
    max_coin_exposure_pct: float
    max_position_sol: float
    max_concurrent_trades: int
    ml_score_multiplier: float = 1.0
    min_ml_score_floor: float = 0.0


@dataclass
class RiskConfig:
    max_risk_per_trade_pct: float = 0.5
    max_total_exposure_pct: float = 15.0
    max_coin_exposure_pct: float = 9.0
    max_position_sol: float = 1.5
    initial_bankroll: float = 10.0
    daily_stop_drawdown_pct: float = 35.0
    max_concurrent_trades: int = 300
    rolling_window_days: int = 30
    risk_level: Literal["low", "normal", "high"] = "normal"
    normal_mode: RiskModeCaps = field(default_factory=lambda: RiskModeCaps("normal", 0.5, 15.0, 9.0, 1.5, 300, 1.0, 0.0))
    survival_mode: RiskModeCaps = field(default_factory=lambda: RiskModeCaps("survival", 0.3, 9.0, 5.5, 1.0, 200, 0.8, 0.65))

    def __post_init__(self):
        assert 0 < self.max_risk_per_trade_pct <= 1.0, "Max risk per trade must stay <= 1%"
        assert 0 < self.max_total_exposure_pct <= 50.0, "Max total exposure must be reasonable"
        assert 0 < self.max_coin_exposure_pct <= self.max_total_exposure_pct
        assert 0 < self.daily_stop_drawdown_pct <= 100.0
        assert self.max_position_sol > 0
        assert self.max_concurrent_trades > 0
        assert self.rolling_window_days >= 5
        assert self.risk_level in ("low", "normal", "high"), f"Invalid risk_level: {self.risk_level}"

    @classmethod
    def from_risk_level(
        cls,
        risk_level: Literal["low", "normal", "high"],
        initial_bankroll: float = 10.0,
        daily_stop_drawdown_pct: float = 35.0,
    ) -> 'RiskConfig':
        """Factory method to create RiskConfig from risk_level preset.
        
        Args:
            risk_level: "low" (testing), "normal" (0.6-0.8 Sharpe), "high" (0.8-1.2 Sharpe)
            initial_bankroll: Starting capital in SOL
            daily_stop_drawdown_pct: Daily DD kill-switch threshold
            
        Returns:
            Configured RiskConfig instance
        """
        presets = {
            "low": {
                "max_risk_per_trade_pct": 0.25,
                "max_total_exposure_pct": 8.0,
                "max_coin_exposure_pct": 5.0,
                "max_position_sol": 0.8,
                "max_concurrent_trades": 250,
                "survival_max_risk_per_trade_pct": 0.12,
                "survival_max_total_exposure_pct": 5.0,
                "survival_max_coin_exposure_pct": 3.5,
                "survival_max_position_sol": 0.5,
                "survival_max_concurrent_trades": 150,
            },
            "normal": {
                "max_risk_per_trade_pct": 0.5,
                "max_total_exposure_pct": 15.0,
                "max_coin_exposure_pct": 9.0,
                "max_position_sol": 1.5,
                "max_concurrent_trades": 300,
                "survival_max_risk_per_trade_pct": 0.3,
                "survival_max_total_exposure_pct": 9.0,
                "survival_max_coin_exposure_pct": 5.5,
                "survival_max_position_sol": 1.0,
                "survival_max_concurrent_trades": 200,
            },
            "high": {
                "max_risk_per_trade_pct": 0.7,
                "max_total_exposure_pct": 20.0,
                "max_coin_exposure_pct": 12.0,
                "max_position_sol": 2.0,
                "max_concurrent_trades": 350,
                "survival_max_risk_per_trade_pct": 0.4,
                "survival_max_total_exposure_pct": 12.0,
                "survival_max_coin_exposure_pct": 7.0,
                "survival_max_position_sol": 1.5,
                "survival_max_concurrent_trades": 250,
            },
        }
        cfg = presets[risk_level]
        return cls(
            max_risk_per_trade_pct=cfg["max_risk_per_trade_pct"],
            max_total_exposure_pct=cfg["max_total_exposure_pct"],
            max_coin_exposure_pct=cfg["max_coin_exposure_pct"],
            max_position_sol=cfg["max_position_sol"],
            initial_bankroll=initial_bankroll,
            daily_stop_drawdown_pct=daily_stop_drawdown_pct,
            max_concurrent_trades=cfg["max_concurrent_trades"],
            risk_level=risk_level,
            normal_mode=RiskModeCaps(
                "normal",
                cfg["max_risk_per_trade_pct"],
                cfg["max_total_exposure_pct"],
                cfg["max_coin_exposure_pct"],
                cfg["max_position_sol"],
                cfg["max_concurrent_trades"],
                1.0,
                0.0,
            ),
            survival_mode=RiskModeCaps(
                "survival",
                cfg["survival_max_risk_per_trade_pct"],
                cfg["survival_max_total_exposure_pct"],
                cfg["survival_max_coin_exposure_pct"],
                cfg["survival_max_position_sol"],
                cfg["survival_max_concurrent_trades"],
                0.8,
                0.65,
            ),
        )


class RiskManager:
    def __init__(self, config: RiskConfig, mode: str = "normal"):
        self.config = config
        self.open_positions: List[Dict[str, Any]] = []
        self.total_pnl_sol = 0.0
        self.bankroll = config.initial_bankroll
        self.peak_equity = config.initial_bankroll
        self.day_peak_equity = config.initial_bankroll
        self.max_drawdown_pct = 0.0
        self.daily_drawdown_pct = 0.0
        self.trades_blocked = 0
        self.kill_switch_triggered = False
        self.coin_exposure_sol: Dict[str, float] = defaultdict(float)
        self.bucket_exposure_sol: Dict[str, float] = defaultdict(float)
        self.daily_realized_pnls: Deque[float] = deque(maxlen=config.rolling_window_days)
        self.active_mode = mode
        self.mode_switches: List[str] = []
        self.set_mode(mode, reason="initialization")

    def set_mode(self, mode: str, reason: str = ""):
        caps = self._caps_for_mode(mode)
        self.active_mode = caps.name
        self.active_caps = caps
        if reason:
            self.mode_switches.append(f"{caps.name}:{reason}")

    def maybe_enable_survival_mode(self, rolling_pnl_sol: float, rolling_sharpe: float, current_dd_pct: float = 0.0):
        if rolling_pnl_sol < 0.0 and rolling_sharpe < 0.0 and self.active_mode != "survival":
            logger.info(
                f"RiskManager → Enabled survival mode: rolling_pnl={rolling_pnl_sol:.2f} SOL, "
                f"rolling_sharpe={rolling_sharpe:.2f}, current_dd={current_dd_pct:.2f}% | "
                f"Risk caps: {self.config.survival_mode.max_risk_per_trade_pct:.2f}% per trade, "
                f"{self.config.survival_mode.max_total_exposure_pct:.1f}% total exposure"
            )
            self.set_mode("survival", reason="rolling_stress_trigger")

    def assess_signal(
        self,
        signal: Dict[str, Any],
        state: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if signal.get("action") != "BUY":
            return signal

        if self.kill_switch_triggered:
            return self._blocked(signal, "daily_kill_switch")

        if len(self.open_positions) >= self.active_caps.max_concurrent_trades:
            return self._blocked(signal, f"concurrency_cap_{self.active_caps.max_concurrent_trades}")

        ml_score = signal.get("ml_score") or 0.0
        effective_score = float(ml_score) * self.active_caps.ml_score_multiplier
        if effective_score < self.active_caps.min_ml_score_floor:
            return self._blocked(signal, f"ml_floor_{self.active_caps.min_ml_score_floor:.2f}")

        requested_size = float(signal.get("amount_sol", 0.0))
        mint = signal.get("mint", "unknown")
        bucket = signal.get("bucket", "default")
        risk_pct = min(signal.get("risk_pct", self.active_caps.max_risk_per_trade_pct), self.active_caps.max_risk_per_trade_pct)
        coin_cap_pct = min(signal.get("coin_risk_cap_pct", self.active_caps.max_coin_exposure_pct), self.active_caps.max_coin_exposure_pct)
        max_total_exposure_pct = min(
            signal.get("max_total_exposure_pct", self.active_caps.max_total_exposure_pct),
            self.active_caps.max_total_exposure_pct,
        )

        current_equity = self.current_equity
        open_exposure = self.open_exposure_sol
        coin_exposure = self.coin_exposure_sol[mint]

        max_by_risk = current_equity * (risk_pct / 100.0)
        max_total_exposure = current_equity * (max_total_exposure_pct / 100.0)
        max_by_total_exposure = max_total_exposure - open_exposure
        max_coin_exposure = current_equity * (coin_cap_pct / 100.0)
        max_by_coin = max_coin_exposure - coin_exposure
        max_by_absolute = self.active_caps.max_position_sol
        max_by_bankroll = max(self.bankroll * 0.5, 0.0)

        capped_size = max(
            0.0,
            min(
                requested_size,
                max_by_risk,
                max_by_total_exposure,
                max_by_coin,
                max_by_absolute,
                max_by_bankroll,
            ),
        )

        if capped_size < 0.001:
            return self._blocked(
                signal,
                (
                    f"risk_limit req={requested_size:.4f} allowed={max(capped_size, 0.0):.4f} "
                    f"coin={coin_exposure:.4f} total={open_exposure:.4f}"
                ),
            )

        result = dict(signal)
        result["amount_sol"] = capped_size
        result["mint"] = mint
        result["bucket"] = bucket
        result["ml_score_effective"] = effective_score
        result["risk_mode"] = self.active_mode

        if capped_size < requested_size and requested_size > 0:
            reduction_pct = (1.0 - capped_size / requested_size) * 100.0
            result["reason"] = f"{signal.get('reason', '')} [capped {reduction_pct:.0f}%]".strip()
        return result

    def on_trade_entry(self, entry: Dict[str, Any]):
        amount = float(entry.get("amount_sol", 0.0))
        mint = entry.get("mint", "unknown")
        bucket = entry.get("bucket", "default")

        self.open_positions.append(dict(entry))
        self.bankroll -= amount
        self.coin_exposure_sol[mint] += amount
        self.bucket_exposure_sol[bucket] += amount
        self._update_drawdown()

    def on_trade_exit(self, exit_trade: Dict[str, Any]):
        amount = float(exit_trade.get("amount_sol", 0.0))
        pnl = float(exit_trade.get("pnl_sol", 0.0))
        mint = exit_trade.get("mint", "unknown")
        bucket = exit_trade.get("bucket", "default")

        self.bankroll += amount + pnl
        self.total_pnl_sol += pnl

        self.coin_exposure_sol[mint] = max(0.0, self.coin_exposure_sol[mint] - amount)
        self.bucket_exposure_sol[bucket] = max(0.0, self.bucket_exposure_sol[bucket] - amount)

        removed = False
        remaining_positions = []
        for pos in self.open_positions:
            if (
                not removed
                and pos.get("mint") == mint
                and pos.get("bucket", "default") == bucket
                and abs(float(pos.get("amount_sol", 0.0)) - amount) < 1e-12
            ):
                removed = True
                continue
            remaining_positions.append(pos)
        self.open_positions = remaining_positions

        self._update_drawdown()

    def record_daily_pnl(self, daily_pnl_sol: float):
        self.daily_realized_pnls.append(float(daily_pnl_sol))

    @property
    def current_equity(self) -> float:
        return self.bankroll + self.open_exposure_sol

    @property
    def open_exposure_sol(self) -> float:
        return sum(float(p.get("amount_sol", 0.0)) for p in self.open_positions)

    def get_current_exposure_pct(self) -> float:
        if self.current_equity <= 0:
            return 100.0
        return (self.open_exposure_sol / self.current_equity) * 100.0

    def build_state(self, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        rolling = self.get_live_guardrails()
        state = {
            "bankroll": self.bankroll,
            "current_equity": self.current_equity,
            "current_exposure_pct": self.get_current_exposure_pct(),
            "coin_exposure_pct": self._coin_exposure_pct(),
            "bucket_exposure_pct": self._bucket_exposure_pct(),
            "stop_trading": self.kill_switch_triggered,
            "daily_drawdown_pct": self.daily_drawdown_pct,
            "risk_mode": self.active_mode,
            "stress_mode": self.active_mode == "survival",
            "ml_score_multiplier": self.active_caps.ml_score_multiplier,
            "min_ml_score_floor": self.active_caps.min_ml_score_floor,
            "rolling_30d_pnl_sol": rolling["rolling_pnl_sol"],
            "rolling_30d_sharpe": rolling["rolling_sharpe"],
        }
        if extra:
            state.update(extra)
        return state

    def get_live_guardrails(self, sol_price_low: float = 150.0) -> Dict[str, Any]:
        daily = list(self.daily_realized_pnls)
        returns = [pnl / max(self.config.initial_bankroll, 1.0) for pnl in daily]
        sharpe = 0.0
        if len(returns) > 1:
            mean_return = sum(returns) / len(returns)
            variance = sum((x - mean_return) ** 2 for x in returns) / len(returns)
            std = variance ** 0.5
            if std > 0:
                sharpe = mean_return / std * (30.0 ** 0.5)
        rolling_pnl_sol = sum(daily)
        rolling_pnl_usd = rolling_pnl_sol * sol_price_low

        messages: List[str] = []
        if len(daily) >= min(10, self.config.rolling_window_days) and sharpe > 2.5 and self.max_drawdown_pct < 5.0:
            messages.append("Warning: strategy may be over-fit to recent regime; re-tune with regime-shifts in backtest")
        if len(daily) >= min(10, self.config.rolling_window_days) and rolling_pnl_sol < 0.0 and sharpe < 0.0:
            messages.append("Stress detected: auto-enable survival-mode with tighter caps and higher thresholds")
        if len(daily) >= min(10, self.config.rolling_window_days) and rolling_pnl_usd < 1_000_000 and sharpe > 2.0:
            messages.append("Info: edge is preserved but not yet 1M/month; consider scaling bankroll, not risk per-trade")

        return {
            "rolling_pnl_sol": rolling_pnl_sol,
            "rolling_pnl_usd": rolling_pnl_usd,
            "rolling_sharpe": sharpe,
            "messages": messages,
            "active_mode": self.active_mode,
        }

    def get_stats(self) -> Dict[str, Any]:
        live = self.get_live_guardrails()
        return {
            "current_equity": self.current_equity,
            "bankroll": self.bankroll,
            "open_exposure_sol": self.open_exposure_sol,
            "open_exposure_pct": self.get_current_exposure_pct(),
            "total_pnl_sol": self.total_pnl_sol,
            "trades_blocked": self.trades_blocked,
            "max_drawdown_pct": self.max_drawdown_pct,
            "daily_drawdown_pct": self.daily_drawdown_pct,
            "peak_equity": self.peak_equity,
            "kill_switch_triggered": self.kill_switch_triggered,
            "active_mode": self.active_mode,
            "mode_switches": "|".join(self.mode_switches),
            "rolling_30d_pnl_sol": live["rolling_pnl_sol"],
            "rolling_30d_sharpe": live["rolling_sharpe"],
            "guardrail_messages": "|".join(live["messages"]),
        }

    def log_summary(self):
        stats = self.get_stats()
        logger.info(
            "\nRisk Management Summary:\n"
            f"  Current Equity: {stats['current_equity']:.4f} SOL\n"
            f"  Open Exposure: {stats['open_exposure_pct']:.1f}% ({stats['open_exposure_sol']:.4f} SOL)\n"
            f"  Total PnL: {stats['total_pnl_sol']:+.4f} SOL\n"
            f"  Trades Blocked: {stats['trades_blocked']}\n"
            f"  Max Drawdown: {stats['max_drawdown_pct']:.2f}%\n"
            f"  Daily DD: {stats['daily_drawdown_pct']:.2f}%\n"
            f"  Active Mode: {stats['active_mode']}\n"
            f"  Kill Switch: {stats['kill_switch_triggered']}\n"
        )

    def _blocked(self, signal: Dict[str, Any], reason: str) -> Dict[str, Any]:
        self.trades_blocked += 1
        return {
            "action": "SKIP",
            "amount_sol": 0.0,
            "reason": reason,
            "ml_score": signal.get("ml_score"),
        }

    def _update_drawdown(self):
        equity = self.current_equity
        if equity > self.peak_equity:
            self.peak_equity = equity
        if equity > self.day_peak_equity:
            self.day_peak_equity = equity

        if self.peak_equity > 0:
            self.max_drawdown_pct = max(
                self.max_drawdown_pct,
                ((self.peak_equity - equity) / self.peak_equity) * 100.0,
            )
        if self.day_peak_equity > 0:
            self.daily_drawdown_pct = ((self.day_peak_equity - equity) / self.day_peak_equity) * 100.0

        if self.daily_drawdown_pct >= self.config.daily_stop_drawdown_pct:
            self.kill_switch_triggered = True

    def _coin_exposure_pct(self) -> Dict[str, float]:
        if self.current_equity <= 0:
            return {}
        return {
            mint: (amount / self.current_equity) * 100.0
            for mint, amount in self.coin_exposure_sol.items()
            if amount > 0
        }

    def _bucket_exposure_pct(self) -> Dict[str, float]:
        if self.current_equity <= 0:
            return {}
        return {
            bucket: (amount / self.current_equity) * 100.0
            for bucket, amount in self.bucket_exposure_sol.items()
            if amount > 0
        }

    def _caps_for_mode(self, mode: str) -> RiskModeCaps:
        if mode == "survival":
            return self.config.survival_mode
        return self.config.normal_mode


def create_risk_manager(
    bankroll: float = 10.0,
    risk_level: Literal["low", "normal", "high"] = "normal",
    daily_stop_drawdown_pct: float = 35.0,
    mode: str = "normal",
    # Legacy parameters (ignored if risk_level is provided via preset)
    max_exposure_pct: Optional[float] = None,
    max_coin_exposure_pct: Optional[float] = None,
    max_risk_per_trade_pct: Optional[float] = None,
    max_position_sol: Optional[float] = None,
    max_concurrent_trades: Optional[int] = None,
    survival_max_risk_per_trade_pct: Optional[float] = None,
    survival_max_exposure_pct: Optional[float] = None,
    survival_max_coin_exposure_pct: Optional[float] = None,
    survival_max_concurrent_trades: Optional[int] = None,
    survival_ml_score_multiplier: Optional[float] = None,
    survival_min_ml_score: Optional[float] = None,
) -> RiskManager:
    """Create a RiskManager with risk_level presets or legacy parameters.
    
    RECOMMENDED: Use risk_level="low"|"normal"|"high" for automatic configuration.
    
    Args:
        bankroll: Initial capital in SOL
        risk_level: Preset ("low": testing, "normal": 0.6-0.8 Sharpe, "high": 0.8-1.2 Sharpe)
        daily_stop_drawdown_pct: Daily drawdown kill-switch threshold (keep ≤ 40%)
        mode: Initial mode ("normal" or "survival")
        (legacy params ignored when using risk_level)
    
    Returns:
        Configured RiskManager instance
    """
    # Use risk_level preset (recommended path)
    if (
        max_exposure_pct is None
        and max_coin_exposure_pct is None
        and max_risk_per_trade_pct is None
    ):
        config = RiskConfig.from_risk_level(
            risk_level=risk_level,
            initial_bankroll=bankroll,
            daily_stop_drawdown_pct=daily_stop_drawdown_pct,
        )
        logger.info(
            f"RiskManager initialized with risk_level='{risk_level}': "
            f"normal({config.normal_mode.max_risk_per_trade_pct:.2f}% risk, "
            f"{config.normal_mode.max_total_exposure_pct:.1f}% exposure, "
            f"{config.normal_mode.max_concurrent_trades} trades) | "
            f"survival({config.survival_mode.max_risk_per_trade_pct:.2f}% risk, "
            f"{config.survival_mode.max_total_exposure_pct:.1f}% exposure, "
            f"{config.survival_mode.max_concurrent_trades} trades)"
        )
    else:
        # Legacy path for backward compatibility
        resolved_max_position_sol = max_position_sol if max_position_sol is not None else max(1.0, bankroll * 0.005)
        config = RiskConfig(
            max_risk_per_trade_pct=max_risk_per_trade_pct or 0.5,
            max_total_exposure_pct=max_exposure_pct or 15.0,
            max_coin_exposure_pct=max_coin_exposure_pct or 9.0,
            max_position_sol=resolved_max_position_sol,
            initial_bankroll=bankroll,
            daily_stop_drawdown_pct=daily_stop_drawdown_pct,
            max_concurrent_trades=max_concurrent_trades or 300,
            risk_level=risk_level,
            normal_mode=RiskModeCaps(
                "normal",
                max_risk_per_trade_pct or 0.5,
                max_exposure_pct or 15.0,
                max_coin_exposure_pct or 9.0,
                resolved_max_position_sol,
                max_concurrent_trades or 300,
                1.0,
                0.0,
            ),
            survival_mode=RiskModeCaps(
                "survival",
                survival_max_risk_per_trade_pct or 0.3,
                survival_max_exposure_pct or 9.0,
                survival_max_coin_exposure_pct or 5.5,
                min(resolved_max_position_sol, max(0.25, resolved_max_position_sol * 0.6)),
                survival_max_concurrent_trades or 200,
                survival_ml_score_multiplier or 0.8,
                survival_min_ml_score or 0.65,
            ),
        )
    return RiskManager(config, mode=mode)
