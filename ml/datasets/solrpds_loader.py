from __future__ import annotations

import csv
from pathlib import Path
from typing import Any


def load_solrpds_csv(path: str | Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            added = float(row.get("TOTAL_ADDED_LIQUIDITY") or row.get("total_added_liquidity") or 0)
            removed = float(row.get("TOTAL_REMOVED_LIQUIDITY") or row.get("total_removed_liquidity") or 0)
            removed_share = removed / max(added + removed, 1e-9)
            rows.append({
                "mint": row.get("TOKEN_ADDRESS") or row.get("token_address"),
                "deployer": row.get("CREATOR") or row.get("creator"),
                "timestamp": row.get("FIRST_POOL_ACTIVITY_TIMESTAMP") or row.get("first_pool_activity_timestamp"),
                "liquidity_removed_share": removed_share,
                "rug": removed_share > 0.9,
            })
    return rows
