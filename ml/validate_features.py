"""Validate training/serving feature parity.

The Python reference computation intentionally mirrors src/features/feature_schema.ts
and then calls the TypeScript serving path in a subprocess. This catches drift in
formulas, clamps, and field defaults before a model is trained on one shape and
served with another.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


FEATURES = [
    "rugPullRisk",
    "honeypotRisk",
    "lpBurnGap",
    "transferTaxPct",
    "topHolderPct",
    "devHoldPct",
    "mutableMetadata",
    "mintAuthority",
    "freezeAuthority",
    "volatility1m",
    "lowLiquidity",
    "lowBuyers",
    "rugcheckLpUnlocked",
    "rugcheckDangerSignals",
]


def clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min(1.0, value))


def compute_python(row: dict[str, Any]) -> dict[str, float]:
    event = row["event"]
    rugcheck = row.get("rugcheck")
    risks = (rugcheck or {}).get("risks") or []
    danger = sum(1 for risk in risks if str(risk.get("level", "")).lower() in {"danger", "critical"})
    if rugcheck:
        lp_locked_pct = rugcheck.get("lpLockedPct", 100 if rugcheck.get("lpLocked") else 0)
    else:
        lp_locked_pct = 0
    return {
        "rugPullRisk": clamp01(float(event.get("rugPullRisk", 0))),
        "honeypotRisk": clamp01(float(event.get("honeypotRisk", 0))),
        "lpBurnGap": clamp01(1 - float(event.get("lpBurnPct", 0))),
        "transferTaxPct": clamp01(float(event.get("transferTaxPct", 0))),
        "topHolderPct": clamp01(float(event.get("topHolderPct", 0))),
        "devHoldPct": clamp01(float(event.get("devHoldPct", 0))),
        "mutableMetadata": 1.0 if event.get("mutableMetadata") else 0.0,
        "mintAuthority": 0.0 if event.get("mintAuthorityRenounced") else 1.0,
        "freezeAuthority": 0.0 if event.get("freezeAuthorityRenounced") else 1.0,
        "volatility1m": clamp01(float(event.get("volatility1m", 0))),
        "lowLiquidity": clamp01(1 / max(float(event.get("liquiditySol", 0.05)), 0.05) / 5),
        "lowBuyers": clamp01(1 - float(event.get("uniqueBuyers", 0)) / 40),
        "rugcheckLpUnlocked": clamp01(1 - float(lp_locked_pct) / 100) if rugcheck else 0.0,
        "rugcheckDangerSignals": clamp01(danger / 4),
    }


def sample_rows(count: int, seed: int) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    rows: list[dict[str, Any]] = []
    for index in range(count):
        event = {
            "mint": f"sample_{index}",
            "deployer": f"deployer_{index % 37}",
            "timestamp": 1_735_689_600_000 + index * 1000,
            "liquiditySol": rng.uniform(0.02, 60),
            "lpBurnPct": rng.uniform(0, 1),
            "ageSeconds": rng.uniform(0, 300),
            "uniqueBuyers": rng.randint(0, 90),
            "totalVolumeSol": rng.uniform(0, 240),
            "marketCapSol": rng.uniform(1, 30_000),
            "rugPullRisk": rng.uniform(-0.1, 1.1),
            "honeypotRisk": rng.uniform(-0.1, 1.1),
            "transferTaxPct": rng.uniform(0, 0.4),
            "topHolderPct": rng.uniform(0, 0.9),
            "devHoldPct": rng.uniform(0, 0.8),
            "mutableMetadata": rng.random() < 0.3,
            "mintAuthorityRenounced": rng.random() < 0.7,
            "freezeAuthorityRenounced": rng.random() < 0.75,
            "volatility1m": rng.uniform(0, 1.2),
            "priceVelocity1m": rng.uniform(-0.5, 0.8),
            "buySellRatio": rng.uniform(0.1, 3.0),
            "jitoCompetition": rng.uniform(0, 1),
            "launchRatePerMinute": rng.uniform(1, 1500),
            "predictedWinProb": rng.uniform(0.3, 0.75),
            "rewardRiskRatio": rng.uniform(0.5, 3.0),
            "synthetic": True,
            "launchPlatform": rng.choice(["pump.fun", "raydium", "other"]),
        }
        rugcheck = None
        if rng.random() < 0.7:
            rugcheck = {
                "lpLocked": rng.random() < 0.65,
                "lpLockedPct": rng.uniform(0, 100),
                "topHoldersPct": rng.uniform(0, 100),
                "risks": [
                    {"level": rng.choice(["info", "warn", "danger", "critical"])}
                    for _ in range(rng.randint(0, 5))
                ],
            }
        rows.append({"event": event, "rugcheck": rugcheck})
    return rows


def run_typescript(rows: list[dict[str, Any]], root: Path) -> list[dict[str, float]]:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".jsonl", delete=False) as handle:
        path = Path(handle.name)
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
    try:
        command = [
            "node",
            "--experimental-strip-types",
            str(root / "src" / "features" / "feature_cli.ts"),
            str(path),
        ]
        completed = subprocess.run(command, cwd=root, text=True, capture_output=True, check=True)
        return json.loads(completed.stdout)
    finally:
        try:
            path.unlink()
        except OSError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-count", type=int, default=10_000)
    parser.add_argument("--seed", type=int, default=20260505)
    parser.add_argument("--max-diff", type=float, default=1e-6)
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    rows = sample_rows(args.sample_count, args.seed)
    expected = [compute_python(row) for row in rows]
    actual = run_typescript(rows, root)

    worst = 0.0
    worst_key = ""
    for row_index, (left, right) in enumerate(zip(expected, actual)):
        for feature in FEATURES:
            diff = abs(float(left[feature]) - float(right[feature]))
            if diff > worst:
                worst = diff
                worst_key = f"row={row_index} feature={feature}"
    if worst > args.max_diff:
        raise SystemExit(f"feature_skew_detected:{worst_key} diff={worst}")
    print(json.dumps({"rows": len(rows), "max_abs_diff": worst, "passed": True}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(exc.stdout)
        sys.stderr.write(exc.stderr)
        raise
