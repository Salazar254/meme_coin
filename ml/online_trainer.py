"""Weekly fine-tuning and drift detection helpers for the rug model."""

from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

import numpy as np


@dataclass
class DriftResult:
    feature: str
    ks_statistic: float
    shifted: bool


def exponential_weight(timestamp_ms: int, now_ms: int, decay: float = 0.93) -> float:
    days_ago = max(0.0, (now_ms - timestamp_ms) / 86_400_000.0)
    return decay ** days_ago


def ks_statistic(reference: Iterable[float], current: Iterable[float]) -> float:
    left = np.sort(np.array(list(reference), dtype=float))
    right = np.sort(np.array(list(current), dtype=float))
    if len(left) == 0 or len(right) == 0:
        return 0.0
    values = np.sort(np.concatenate([left, right]))
    left_cdf = np.searchsorted(left, values, side="right") / len(left)
    right_cdf = np.searchsorted(right, values, side="right") / len(right)
    return float(np.max(np.abs(left_cdf - right_cdf)))


def detect_feature_drift(
    reference_rows: list[dict[str, float]],
    current_rows: list[dict[str, float]],
    feature_names: list[str],
    threshold: float = 0.18,
) -> list[DriftResult]:
    results: list[DriftResult] = []
    for feature in feature_names:
        stat = ks_statistic(
            [float(row.get(feature, 0.0)) for row in reference_rows],
            [float(row.get(feature, 0.0)) for row in current_rows],
        )
        results.append(DriftResult(feature=feature, ks_statistic=stat, shifted=stat >= threshold))
    return results


def build_weekly_job_manifest(
    labeled_outcomes_path: str,
    current_model_path: str = "models/rug_model.onnx",
    candidate_model_path: str = "models/rug_model_candidate.onnx",
) -> dict[str, object]:
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    rows: list[dict[str, object]] = []
    if os.path.exists(labeled_outcomes_path):
        with open(labeled_outcomes_path, "r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                row = json.loads(line)
                timestamp = int(row.get("timestamp_ms") or row.get("timestamp") or now_ms)
                if timestamp < 10_000_000_000:
                    timestamp *= 1000
                if now_ms - timestamp <= 30 * 86_400_000:
                    row["training_weight"] = exponential_weight(timestamp, now_ms)
                    rows.append(row)
    return {
        "job": "weekly_online_fine_tune",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": labeled_outcomes_path,
        "current_model": current_model_path,
        "candidate_model": candidate_model_path,
        "fine_tune": {
            "freeze_backbone": True,
            "learning_rate": 1e-4,
            "max_epochs": 50,
            "discard_if_val_auc_below": 0.75,
            "weighting": "0.93^days_ago",
            "samples_last_30d": len(rows),
        },
        "ab_test": {
            "mode": "shadow",
            "duration_hours": 72,
            "promote_if": ["lower_log_loss", "no_drift_alarm", "pnl_drawdown_not_worse"],
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--outcomes", default="data/labeled_outcomes.jsonl")
    parser.add_argument("--manifest", default="models/online_training_manifest.json")
    args = parser.parse_args()
    manifest = build_weekly_job_manifest(args.outcomes)
    os.makedirs(os.path.dirname(args.manifest), exist_ok=True)
    with open(args.manifest, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
