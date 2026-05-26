from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_pumpstudio_jsonl(path: str | Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            item = json.loads(line)
            if item.get("validated") is False:
                continue
            price_change_1h = float(item.get("price_change_1h") or item.get("priceChange1h") or 0)
            liquidity_removed = float(item.get("liquidity_removed_pct") or 0)
            deployer_dump = float(item.get("deployer_dump_pct") or 0)
            rows.append({
                "mint": item.get("mint"),
                "deployer": item.get("deployer") or item.get("creator"),
                "timestamp": item.get("timestamp") or item.get("snapshot_at"),
                "rug": liquidity_removed > 0.9 or deployer_dump > 0.8,
                "pump_2x": price_change_1h >= 1.0,
            })
    return rows
