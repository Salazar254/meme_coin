"""
ml/train.py - Soft-target ensemble training pipeline with walk-forward support.

Usage:
    python -m ml.train
    python -m ml.train --target pnl_10m --target-mode regression --walk-forward
    python -m ml.train --target pnl_10m --target-mode probability --threshold 0.10
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Tuple

import click
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backtest.replay import load_events, rolling_windows, time_split
from ml.features import FEATURE_NAMES, events_to_dataset, normalize_features
from ml.nn_model import NNModel
from ml.xgb_model import XGBModel
from src.log_setup import setup_logging, console

logger = setup_logging("INFO")


def _ensemble_predictions(nn_preds: np.ndarray, xgb_preds: np.ndarray) -> np.ndarray:
    return 0.5 * nn_preds + 0.5 * xgb_preds


def _evaluate_target(y_true: np.ndarray, preds: np.ndarray, target_mode: str) -> Dict[str, float]:
    metrics: Dict[str, float] = {}
    if len(y_true) == 0:
        return {"rmse": 0.0, "corr": 0.0, "hit_rate": 0.0}

    metrics["rmse"] = float(np.sqrt(np.mean((preds - y_true) ** 2)))
    if len(y_true) > 1:
        corr = np.corrcoef(y_true, preds)[0, 1]
        metrics["corr"] = float(0.0 if np.isnan(corr) else corr)
    else:
        metrics["corr"] = 0.0

    if target_mode == "regression":
        metrics["hit_rate"] = float(np.mean((preds > 0) == (y_true > 0)))
    else:
        binary_preds = (preds >= 0.5).astype(int)
        metrics["hit_rate"] = float(np.mean(binary_preds == y_true))
    return metrics


def _overfitting_warning(metrics: Dict[str, float], sharpe_like: float = 0.0, max_dd_like: float = 0.0) -> str:
    warnings: List[str] = []
    train_corr = metrics.get("train_corr", 0.0)
    val_corr = metrics.get("val_corr", 0.0)
    if train_corr - val_corr > 0.20:
        warnings.append("train_val_gap")
    if sharpe_like > 2.0 and max_dd_like < 0.10:
        warnings.append("suspicious_sharpe_dd")
    return "|".join(warnings)


def _train_single_split(
    train_events: List[Dict[str, Any]],
    val_events: List[Dict[str, Any]],
    test_events: List[Dict[str, Any]],
    target_key: str,
    target_mode: str,
    binary_threshold: float,
    nn_epochs: int,
) -> Dict[str, Any]:
    X_train, y_train = events_to_dataset(train_events, target_key=target_key, target_mode=target_mode, binary_threshold=binary_threshold)
    X_val, y_val = events_to_dataset(val_events, target_key=target_key, target_mode=target_mode, binary_threshold=binary_threshold)
    X_test, y_test = events_to_dataset(test_events, target_key=target_key, target_mode=target_mode, binary_threshold=binary_threshold)

    X_train_n, X_val_n, X_test_n, mean, std = normalize_features(X_train, X_val, X_test)

    nn_model = NNModel(input_dim=X_train_n.shape[1], task=target_mode)
    nn_model.train_model(X_train_n, y_train, X_val_n, y_val, epochs=nn_epochs)

    xgb_model = XGBModel(task=target_mode)
    xgb_model.train_model(X_train_n, y_train, X_val_n, y_val)

    train_nn_preds = nn_model.predict_batch(X_train_n)
    val_nn_preds = nn_model.predict_batch(X_val_n)
    test_nn_preds = nn_model.predict_batch(X_test_n)

    train_xgb_preds = xgb_model.predict_batch(X_train_n)
    val_xgb_preds = xgb_model.predict_batch(X_val_n)
    test_xgb_preds = xgb_model.predict_batch(X_test_n)

    train_preds = _ensemble_predictions(train_nn_preds, train_xgb_preds)
    val_preds = _ensemble_predictions(val_nn_preds, val_xgb_preds)
    test_preds = _ensemble_predictions(test_nn_preds, test_xgb_preds)

    metrics = {}
    for split_name, y_true, preds in [
        ("train", y_train, train_preds),
        ("val", y_val, val_preds),
        ("test", y_test, test_preds),
    ]:
        split_metrics = _evaluate_target(y_true, preds, target_mode)
        for metric_name, value in split_metrics.items():
            metrics[f"{split_name}_{metric_name}"] = value

    os.makedirs("ml/saved_models", exist_ok=True)
    np.savez("ml/saved_models/norm_params.npz", mean=mean, std=std, feature_names=np.array(FEATURE_NAMES, dtype=object))
    nn_model.save("ml/saved_models/nn_model.pt")
    xgb_model.save("ml/saved_models/xgb_model.json")
    with open("ml/saved_models/ensemble_meta.json", "w", encoding="utf-8") as handle:
        json.dump(
            {
                "target_key": target_key,
                "target_mode": target_mode,
                "binary_threshold": binary_threshold,
                "feature_names": FEATURE_NAMES,
                "weights": {"nn": 0.5, "xgb": 0.5},
                "metrics": metrics,
            },
            handle,
            indent=2,
        )

    metrics["overfit_warning"] = _overfitting_warning(metrics)
    return metrics


def train_pipeline(
    db_path: str = "data/events.db",
    target_key: str = "pnl_10m",
    target_mode: str = "regression",
    binary_threshold: float = 0.10,
    train_frac: float = 0.6,
    val_frac: float = 0.2,
    nn_epochs: int = 50,
    walk_forward: bool = False,
) -> Dict[str, Any]:
    console.print("\n[bold cyan]ML Training Pipeline[/bold cyan]\n")
    events = load_events(db_path, limit=50000)
    if len(events) < 50:
        raise RuntimeError(f"Need at least 50 events, found {len(events)}")

    logger.info("Loaded %d events for target=%s mode=%s", len(events), target_key, target_mode)

    if walk_forward:
        windows = rolling_windows(events, train_size=1000, test_size=250, step=250)
        if not windows:
            raise RuntimeError("Not enough events for walk-forward windows")
        window_summaries = []
        for index, (train_events, test_events) in enumerate(windows, start=1):
            train_split, val_split, _ = time_split(train_events, train_frac=train_frac, val_frac=val_frac)
            metrics = _train_single_split(train_split, val_split, test_events, target_key, target_mode, binary_threshold, nn_epochs)
            metrics["window"] = index
            window_summaries.append(metrics)
            logger.info("Window %d | val_corr=%.3f test_corr=%.3f", index, metrics.get("val_corr", 0.0), metrics.get("test_corr", 0.0))
        summary = {
            "windows": window_summaries,
            "mean_test_corr": float(np.mean([item.get("test_corr", 0.0) for item in window_summaries])),
            "mean_test_rmse": float(np.mean([item.get("test_rmse", 0.0) for item in window_summaries])),
        }
    else:
        train_events, val_events, test_events = time_split(events, train_frac=train_frac, val_frac=val_frac)
        summary = _train_single_split(train_events, val_events, test_events, target_key, target_mode, binary_threshold, nn_epochs)

    with open("ml/saved_models/training_summary.json", "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    logger.info("Training complete. Summary written to ml/saved_models/training_summary.json")
    return summary


@click.command()
@click.option("--db-path", default="data/events.db", show_default=True)
@click.option("--target", "target_key", default="pnl_10m", show_default=True)
@click.option("--target-mode", type=click.Choice(["regression", "probability", "classification"]), default="regression", show_default=True)
@click.option("--threshold", "binary_threshold", default=0.10, show_default=True, type=float)
@click.option("--epochs", "nn_epochs", default=50, show_default=True, type=int)
@click.option("--walk-forward", is_flag=True, help="Run rolling walk-forward training.")
def main(db_path: str, target_key: str, target_mode: str, binary_threshold: float, nn_epochs: int, walk_forward: bool):
    train_pipeline(
        db_path=db_path,
        target_key=target_key,
        target_mode=target_mode,
        binary_threshold=binary_threshold,
        nn_epochs=nn_epochs,
        walk_forward=walk_forward,
    )


if __name__ == "__main__":
    main()
