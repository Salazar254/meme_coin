from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def parse_program_logs(path: str | Path) -> list[dict[str, Any]]:
    examples: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            program = str(row.get("program") or row.get("programId") or "").lower()
            logs = " ".join(str(item) for item in row.get("logs", []))
            platform = "pump.fun" if "pump" in program or "pump" in logs.lower() else "raydium" if "raydium" in program or "raydium" in logs.lower() else "unknown"
            liquidity_removed = float(row.get("liquidity_removed_pct") or row.get("liquidityRemovedPct") or 0)
            deployer_dump = float(row.get("deployer_dump_pct") or row.get("deployerDumpPct") or 0)
            examples.append({
                "mint": row.get("mint"),
                "deployer": row.get("deployer") or row.get("authority"),
                "timestamp": row.get("timestamp") or row.get("blockTime"),
                "platform": platform,
                "rug": liquidity_removed > 0.9 or deployer_dump > 0.8,
                "time_to_rug_hours": min(float(row.get("time_to_rug_hours") or 72), 72),
            })
    return examples
