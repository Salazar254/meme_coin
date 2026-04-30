"""
ml/features.py - Feature engineering for higher-volume, regime-aware ML models.

Design goals:
  - Use only information available at event time
  - Support soft regression targets and probability targets
  - Expose short-horizon microstructure proxies for launch quality
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

FEATURE_NAMES = [
    "liquidity_sol",
    "liquidity_usd",
    "unique_buyers",
    "total_volume",
    "market_cap_sol",
    "time_since_launch",
    "slippage_estimate",
    "price_growth_1s",
    "social_proxy_1s",
    "lp_growth_1s",
    "buyers_per_sol",
    "volume_to_lp_ratio",
    "log_liquidity",
    "log_volume",
    "log_mcap",
    "hour_of_day",
    "day_of_week",
    "is_weekend",
]

NUM_FEATURES = len(FEATURE_NAMES)


def event_to_features(event: Dict[str, Any]) -> np.ndarray:
    lp_sol = max(float(event.get("liquidity_sol", 0.0)), 0.0)
    lp_usd = max(float(event.get("liquidity_usd", lp_sol * 150.0)), 0.0)
    buyers = max(int(event.get("unique_buyers", 0)), 0)
    volume = max(float(event.get("total_volume", 0.0)), 0.0)
    mcap = max(float(event.get("market_cap_sol", lp_sol * 2.0)), 0.0)
    age = float(event.get("time_since_launch", event.get("age_seconds", 0.0)))

    log_lp = np.log1p(lp_sol)
    log_vol = np.log1p(volume)
    log_mcap = np.log1p(mcap)
    buyers_per_sol = buyers / max(lp_sol, 0.01)
    vol_to_lp = volume / max(lp_sol, 0.01)

    price_growth_1s = float(event.get("price_growth_1s", _clip((float(event.get("pnl_1m", 0.0)) / 60.0) * 8.0)))
    social_proxy_1s = float(event.get("social_proxy_1s", _clip((buyers_per_sol / 3.0))))
    lp_growth_1s = float(event.get("lp_growth_1s", _clip((vol_to_lp - 1.0) / 10.0)))
    slippage_estimate = float(event.get("slippage_estimate", _clip(0.03 + 0.15 / max(np.sqrt(max(lp_sol, 0.01)), 1e-6), 0.0, 1.0)))

    ts = float(event.get("timestamp", 0.0))
    dt = datetime.fromtimestamp(ts, tz=timezone.utc) if ts > 0 else datetime.fromtimestamp(0, tz=timezone.utc)
    hour = dt.hour
    dow = dt.weekday()
    is_weekend = 1 if dow >= 5 else 0

    features = np.array([
        lp_sol,
        lp_usd,
        buyers,
        volume,
        mcap,
        age,
        slippage_estimate,
        price_growth_1s,
        social_proxy_1s,
        lp_growth_1s,
        buyers_per_sol,
        vol_to_lp,
        log_lp,
        log_vol,
        log_mcap,
        hour,
        dow,
        is_weekend,
    ], dtype=np.float32)
    return features


def events_to_dataset(
    events: List[Dict[str, Any]],
    target_key: str = "pnl_5m",
    target_mode: str = "regression",
    binary_threshold: Optional[float] = None,
) -> Tuple[np.ndarray, np.ndarray]:
    X_list: List[np.ndarray] = []
    y_list: List[float] = []

    for event in events:
        target = event.get(target_key)
        if target is None:
            continue

        X_list.append(event_to_features(event))
        if target_mode == "classification":
            threshold = 0.0 if binary_threshold is None else binary_threshold
            y_list.append(1.0 if float(target) >= threshold else 0.0)
        elif target_mode == "probability":
            threshold = 0.10 if binary_threshold is None else binary_threshold
            y_list.append(1.0 if float(target) >= threshold else 0.0)
        else:
            y_list.append(float(target))

    if not X_list:
        return np.array([]).reshape(0, NUM_FEATURES), np.array([])

    return np.stack(X_list), np.array(y_list, dtype=np.float32)


def normalize_features(
    X_train: np.ndarray,
    X_val: np.ndarray = None,
    X_test: np.ndarray = None,
    clip_std: float = 5.0,
):
    mean = X_train.mean(axis=0)
    std = X_train.std(axis=0)
    std = np.where(std < 1e-6, 1.0, std)

    def _normalize(X: Optional[np.ndarray]) -> Optional[np.ndarray]:
        if X is None:
            return None
        Xn = (X - mean) / std
        return np.clip(Xn, -clip_std, clip_std)

    return _normalize(X_train), _normalize(X_val), _normalize(X_test), mean, std


def _clip(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))
