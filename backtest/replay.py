"""
backtest/replay.py — Event replay utilities for backtesting.

Provides helpers to load, filter, and replay events from the local
database in various modes (chronological, windowed, sampled).
"""

import os
import sys
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from data.db import get_db


def load_events(
    db_path: str = "data/events.db",
    start_time: Optional[float] = None,
    end_time: Optional[float] = None,
    source: Optional[str] = None,
    limit: int = 50000,
) -> List[Dict[str, Any]]:
    """Load events from the database in chronological order."""
    db = get_db(db_path)
    return db.get_events(
        start_time=start_time,
        end_time=end_time,
        source=source,
        limit=limit,
    )


def time_split(
    events: List[Dict[str, Any]],
    train_frac: float = 0.6,
    val_frac: float = 0.2,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Split events into train/validation/test sets BY TIME (not random).

    This is critical for avoiding look-ahead bias in backtesting/ML.

    Args:
        events: Chronologically sorted events
        train_frac: Fraction for training (default 60%)
        val_frac: Fraction for validation (default 20%)
        (remaining = test)

    Returns:
        (train_events, val_events, test_events)
    """
    n = len(events)
    train_end = int(n * train_frac)
    val_end = int(n * (train_frac + val_frac))

    return events[:train_end], events[train_end:val_end], events[val_end:]


def rolling_windows(
    events: List[Dict[str, Any]],
    train_size: int = 1000,
    test_size: int = 200,
    step: int = 200,
) -> List[Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]]:
    """
    Generate rolling train/test windows for walk-forward analysis.

    Args:
        events: Chronologically sorted events
        train_size: Number of events per training window
        test_size: Number of events per test window
        step: How many events to advance each iteration

    Yields:
        List of (train_window, test_window) tuples
    """
    windows = []
    i = 0

    while i + train_size + test_size <= len(events):
        train = events[i : i + train_size]
        test = events[i + train_size : i + train_size + test_size]
        windows.append((train, test))
        i += step

    return windows


def summarize_events(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Produce a summary of an event set for inspection."""
    if not events:
        return {"count": 0}

    timestamps = [e.get("timestamp", 0) for e in events]
    lps = [e.get("liquidity_sol", 0) for e in events]

    return {
        "count": len(events),
        "time_range": {
            "start": datetime.fromtimestamp(min(timestamps)).isoformat() if timestamps else None,
            "end": datetime.fromtimestamp(max(timestamps)).isoformat() if timestamps else None,
        },
        "liquidity_sol": {
            "mean": sum(lps) / len(lps) if lps else 0,
            "min": min(lps) if lps else 0,
            "max": max(lps) if lps else 0,
        },
        "sources": list(set(e.get("source", "unknown") for e in events)),
    }
