"""
src/high_volume_strategy.py - Multi-bucket, regime-aware strategy for higher volume.

This strategy is designed to widen the opportunity set without abandoning
hard risk controls. It introduces:
  - Three execution buckets with different timing windows and risk caps
  - Regime-aware threshold/risk adaptation
  - Explicit organic growth checks
  - Per-launch and per-bucket sizing hints for the risk manager
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
import math
import statistics


@dataclass
class StrategyBucket:
    name: str
    min_age_seconds: float
    max_age_seconds: float
    min_lp_sol: float
    min_unique_buyers: int
    min_ml_score: float
    risk_pct: float
    max_coin_exposure_pct: float
    max_total_bucket_exposure_pct: float
    require_social_strength: bool = False
    strict_growth: bool = False


@dataclass
class RegimeProfile:
    name: str
    score_threshold_offset: float
    lp_multiplier: float
    risk_multiplier: float
    time_window_multiplier: float


@dataclass
class StrategyConfig:
    base_position_floor_sol: float = 0.01
    max_trade_risk_pct: float = 0.5
    max_total_exposure_pct: float = 10.0
    max_coin_exposure_pct: float = 7.5
    min_organic_growth_score: float = 0.25
    buckets: List[StrategyBucket] = field(
        default_factory=lambda: [
            StrategyBucket(
                name="ultra_fast",
                min_age_seconds=0.0,
                max_age_seconds=2.0,
                min_lp_sol=1.0,
                min_unique_buyers=4,
                min_ml_score=0.60,
                risk_pct=0.18,
                max_coin_exposure_pct=5.0,
                max_total_bucket_exposure_pct=3.0,
                strict_growth=True,
            ),
            StrategyBucket(
                name="fast_react",
                min_age_seconds=2.0,
                max_age_seconds=6.0,
                min_lp_sol=0.8,
                min_unique_buyers=5,
                min_ml_score=0.53,
                risk_pct=0.32,
                max_coin_exposure_pct=7.0,
                max_total_bucket_exposure_pct=4.5,
            ),
            StrategyBucket(
                name="late_snipe",
                min_age_seconds=6.0,
                max_age_seconds=10.0,
                min_lp_sol=0.5,
                min_unique_buyers=6,
                min_ml_score=0.67,
                risk_pct=0.22,
                max_coin_exposure_pct=6.0,
                max_total_bucket_exposure_pct=3.0,
                require_social_strength=True,
            ),
        ]
    )
    regimes: Dict[str, RegimeProfile] = field(
        default_factory=lambda: {
            "bull": RegimeProfile(
                name="bull",
                score_threshold_offset=-0.04,
                lp_multiplier=0.90,
                risk_multiplier=1.10,
                time_window_multiplier=1.15,
            ),
            "flat": RegimeProfile(
                name="flat",
                score_threshold_offset=0.00,
                lp_multiplier=1.00,
                risk_multiplier=1.00,
                time_window_multiplier=1.00,
            ),
            "bear": RegimeProfile(
                name="bear",
                score_threshold_offset=0.05,
                lp_multiplier=1.15,
                risk_multiplier=0.70,
                time_window_multiplier=0.85,
            ),
        }
    )


class RegimeDetector:
    """Infer a simple bull/flat/bear regime from recent realized PnL and volatility."""

    def detect(self, state: Dict[str, Any]) -> str:
        recent_pnls = state.get("recent_closed_pnls", [])[-50:]
        recent_volatility = state.get("recent_volatility", 0.0)
        if not recent_pnls:
            return "flat"

        avg_pnl = statistics.mean(recent_pnls)
        pnl_std = statistics.pstdev(recent_pnls) if len(recent_pnls) > 1 else 0.0

        if avg_pnl > 0.06 and recent_volatility < 0.45 and pnl_std < 0.35:
            return "bull"
        if avg_pnl < -0.03 or recent_volatility > 0.85:
            return "bear"
        return "flat"


class VolumeScalingStrategy:
    """
    Multi-bucket strategy targeting more trades while respecting hard caps.

    Input expectations:
      event:
        liquidity_sol, unique_buyers, time_since_launch, price_growth_1s,
        social_proxy_1s, lp_growth_1s, slippage_estimate, ml_score, mint
      state:
        bankroll, current_equity, current_exposure_pct, coin_exposure_pct,
        bucket_exposure_pct, recent_closed_pnls, recent_volatility, stop_trading
    """

    def __init__(self, config: Optional[StrategyConfig] = None):
        self.config = config or StrategyConfig()
        self.regime_detector = RegimeDetector()
        self.stats = {
            "evaluated": 0,
            "entered": 0,
            "skipped": 0,
            "by_bucket": {bucket.name: 0 for bucket in self.config.buckets},
            "by_regime": {name: 0 for name in self.config.regimes},
        }

    def decide(self, event: Dict[str, Any], state: Dict[str, Any]) -> Dict[str, Any]:
        self.stats["evaluated"] += 1

        if state.get("stop_trading"):
            return self._skip("daily_kill_switch_active")

        regime_name = self.regime_detector.detect(state)
        regime = self.config.regimes[regime_name]
        self.stats["by_regime"][regime_name] += 1

        event = self._enrich_event(event)
        event["stress_mode"] = bool(state.get("stress_mode", False))
        event["min_ml_score_floor"] = float(state.get("min_ml_score_floor", 0.0))
        organic_growth = self._organic_growth_score(event)
        candidate_bucket = self._select_bucket(event, regime, organic_growth)

        if candidate_bucket is None:
            return self._skip("no_bucket_match")

        coin_exposure_pct = state.get("coin_exposure_pct", {}).get(event.get("mint", ""), 0.0)
        if coin_exposure_pct >= min(
            candidate_bucket.max_coin_exposure_pct,
            self.config.max_coin_exposure_pct,
        ):
            return self._skip(f"coin_exposure_cap_{coin_exposure_pct:.2f}")

        bucket_exposure_pct = state.get("bucket_exposure_pct", {}).get(candidate_bucket.name, 0.0)
        if bucket_exposure_pct >= candidate_bucket.max_total_bucket_exposure_pct:
            return self._skip(f"bucket_exposure_cap_{bucket_exposure_pct:.2f}")

        if state.get("current_exposure_pct", 0.0) >= self.config.max_total_exposure_pct:
            return self._skip("total_exposure_cap")

        equity = state.get("current_equity", state.get("bankroll", 0.0))
        risk_pct = min(
            candidate_bucket.risk_pct * regime.risk_multiplier,
            self.config.max_trade_risk_pct,
        )
        score_multiplier = float(state.get("ml_score_multiplier", 1.0))
        score = min(1.0, max(0.0, event.get("ml_score", 0.5) * score_multiplier))
        score_boost = 0.85 + max(score - 0.5, 0.0)
        amount_sol = max(
            self.config.base_position_floor_sol,
            equity * (risk_pct / 100.0) * score_boost,
        )

        self.stats["entered"] += 1
        self.stats["by_bucket"][candidate_bucket.name] += 1
        return {
            "action": "BUY",
            "amount_sol": amount_sol,
            "reason": (
                f"bucket={candidate_bucket.name} regime={regime_name} "
                f"lp={event['liquidity_sol']:.2f} buyers={event['unique_buyers']} "
                f"ml={score:.3f} organic={organic_growth:.2f}"
            ),
            "bucket": candidate_bucket.name,
            "ml_score": score,
            "risk_pct": risk_pct,
            "coin_risk_cap_pct": min(
                candidate_bucket.max_coin_exposure_pct,
                self.config.max_coin_exposure_pct,
            ),
            "regime": regime_name,
            "organic_growth_score": organic_growth,
            "max_total_exposure_pct": self.config.max_total_exposure_pct,
        }

    def get_stats(self) -> Dict[str, Any]:
        entered = self.stats["entered"]
        evaluated = max(self.stats["evaluated"], 1)
        return {
            **self.stats,
            "entry_rate": entered / evaluated,
        }

    def _select_bucket(
        self,
        event: Dict[str, Any],
        regime: RegimeProfile,
        organic_growth_score: float,
    ) -> Optional[StrategyBucket]:
        age = event.get("time_since_launch", 9999.0)
        stress_mode = bool(event.get("stress_mode", False))
        min_ml_score_floor = float(event.get("min_ml_score_floor", 0.0))
        for bucket in self.config.buckets:
            max_age = bucket.max_age_seconds * regime.time_window_multiplier
            min_lp = bucket.min_lp_sol * regime.lp_multiplier
            min_score = max(0.0, min(1.0, bucket.min_ml_score + regime.score_threshold_offset))
            if stress_mode:
                min_lp *= 1.10
                min_score = max(min_score, min_ml_score_floor, bucket.min_ml_score + 0.03)
                max_age *= 0.90

            if age < bucket.min_age_seconds or age > max_age:
                continue
            if event.get("liquidity_sol", 0.0) < min_lp:
                continue
            if event.get("unique_buyers", 0) < bucket.min_unique_buyers:
                continue
            if event.get("ml_score", 0.5) < min_score:
                continue
            if organic_growth_score < self.config.min_organic_growth_score:
                continue
            if bucket.strict_growth and event.get("lp_growth_1s", 0.0) <= 0:
                continue
            if bucket.require_social_strength and event.get("social_proxy_1s", 0.0) < 0.2:
                continue
            max_slippage = 0.24 if stress_mode else 0.30
            if event.get("slippage_estimate", 0.0) > max_slippage:
                continue
            return bucket
        return None

    def _organic_growth_score(self, event: Dict[str, Any]) -> float:
        buyers = min(event.get("unique_buyers", 0) / 20.0, 1.0)
        lp_growth = max(min(event.get("lp_growth_1s", 0.0), 1.0), -1.0)
        price_growth = max(min(event.get("price_growth_1s", 0.0), 1.0), -1.0)
        social = max(min(event.get("social_proxy_1s", 0.0), 1.0), 0.0)
        score = 0.35 * buyers + 0.25 * max(lp_growth, 0.0) + 0.2 * max(price_growth, 0.0) + 0.2 * social
        return max(0.0, min(score, 1.0))

    def _enrich_event(self, event: Dict[str, Any]) -> Dict[str, Any]:
        enriched = dict(event)
        lp = max(enriched.get("liquidity_sol", 0.0), 0.01)
        buyers = max(enriched.get("unique_buyers", 0), 0)
        volume = max(enriched.get("total_volume", lp), 0.0)

        enriched.setdefault("time_since_launch", enriched.get("age_seconds", 0.0))
        enriched.setdefault("price_growth_1s", self._clip((enriched.get("pnl_1m", 0.0) / 60.0) * 8.0))
        enriched.setdefault("lp_growth_1s", self._clip((volume / lp - 1.0) / 10.0))
        enriched.setdefault("social_proxy_1s", self._clip((buyers / max(lp * 10.0, 1.0)) / 3.0))
        enriched.setdefault("slippage_estimate", self._clip(0.03 + 0.15 / math.sqrt(lp), low=0.0, high=1.0))
        enriched.setdefault("ml_score", self._clip(self._fallback_ml_score(enriched), low=0.0, high=1.0))
        return enriched

    def _fallback_ml_score(self, event: Dict[str, Any]) -> float:
        lp_signal = self._sigmoid((event.get("liquidity_sol", 0.0) - 0.7) * 1.5)
        buyers_signal = self._sigmoid((event.get("unique_buyers", 0) - 6.0) / 3.0)
        pnl_signal = self._sigmoid(event.get("pnl_5m", 0.0) * 3.0)
        social_signal = self._sigmoid(event.get("social_proxy_1s", 0.0) * 2.0)
        return 0.30 * lp_signal + 0.25 * buyers_signal + 0.30 * pnl_signal + 0.15 * social_signal

    @staticmethod
    def _sigmoid(value: float) -> float:
        return 1.0 / (1.0 + math.exp(-max(min(value, 10.0), -10.0)))

    @staticmethod
    def _clip(value: float, low: float = -1.0, high: float = 1.0) -> float:
        return max(low, min(high, value))

    def _skip(self, reason: str) -> Dict[str, Any]:
        self.stats["skipped"] += 1
        return {
            "action": "SKIP",
            "amount_sol": 0.0,
            "reason": reason,
            "ml_score": None,
        }
