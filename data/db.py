"""
data/db.py — SQLite database helper for the Solana meme-coin sniping bot.

Provides connection management, schema initialization, and CRUD operations
for events, trades, and ML training runs.
"""

import sqlite3
import os
import time
from pathlib import Path
from typing import Optional, List, Dict, Any


# ─── Default DB path (relative to project root) ───
DEFAULT_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "events.db")
SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")


class Database:
    """Thin SQLite wrapper with schema auto-init and helper methods."""

    def __init__(self, db_path: str = DEFAULT_DB_PATH):
        self.db_path = db_path
        self.conn: Optional[sqlite3.Connection] = None

    # ── Connection lifecycle ──

    def connect(self) -> sqlite3.Connection:
        """Open (or reuse) a SQLite connection and initialize schema."""
        if self.conn is None:
            os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
            self.conn = sqlite3.connect(self.db_path)
            self.conn.row_factory = sqlite3.Row          # dict-like rows
            self.conn.execute("PRAGMA journal_mode=WAL")  # better concurrency
            self._init_schema()
        return self.conn

    def close(self):
        if self.conn:
            self.conn.close()
            self.conn = None

    def _init_schema(self):
        """Run schema.sql to create tables if they don't exist."""
        if os.path.exists(SCHEMA_PATH):
            with open(SCHEMA_PATH, "r") as f:
                self.conn.executescript(f.read())

    # ── Events CRUD ──

    def insert_event(self, event: Dict[str, Any]) -> int:
        """Insert a new event and return its row ID."""
        conn = self.connect()
        cols = ", ".join(event.keys())
        placeholders = ", ".join(["?"] * len(event))
        cur = conn.execute(
            f"INSERT INTO events ({cols}) VALUES ({placeholders})",
            list(event.values()),
        )
        conn.commit()
        return cur.lastrowid

    def get_events(
        self,
        start_time: Optional[float] = None,
        end_time: Optional[float] = None,
        source: Optional[str] = None,
        limit: int = 10000,
    ) -> List[Dict[str, Any]]:
        """Fetch events in chronological order, optionally filtered."""
        conn = self.connect()
        query = "SELECT * FROM events WHERE 1=1"
        params: list = []

        if start_time is not None:
            query += " AND timestamp >= ?"
            params.append(start_time)
        if end_time is not None:
            query += " AND timestamp <= ?"
            params.append(end_time)
        if source is not None:
            query += " AND source = ?"
            params.append(source)

        query += " ORDER BY timestamp ASC LIMIT ?"
        params.append(limit)

        rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]

    def get_event_count(self) -> int:
        """Return total number of events in the database."""
        conn = self.connect()
        return conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]

    def update_event_prices(self, event_id: int, prices: Dict[str, float]):
        """Update price snapshot columns for an event."""
        conn = self.connect()
        sets = ", ".join([f"{k} = ?" for k in prices.keys()])
        conn.execute(
            f"UPDATE events SET {sets} WHERE id = ?",
            list(prices.values()) + [event_id],
        )
        conn.commit()

    # ── Trades CRUD ──

    def insert_trade(self, trade: Dict[str, Any]) -> int:
        """Insert a new trade and return its row ID."""
        conn = self.connect()
        cols = ", ".join(trade.keys())
        placeholders = ", ".join(["?"] * len(trade))
        cur = conn.execute(
            f"INSERT INTO trades ({cols}) VALUES ({placeholders})",
            list(trade.values()),
        )
        conn.commit()
        return cur.lastrowid

    def get_trades(self, mode: Optional[str] = None, status: Optional[str] = None) -> List[Dict[str, Any]]:
        """Fetch trades, optionally filtered by mode and/or status."""
        conn = self.connect()
        query = "SELECT * FROM trades WHERE 1=1"
        params: list = []

        if mode:
            query += " AND mode = ?"
            params.append(mode)
        if status:
            query += " AND status = ?"
            params.append(status)

        query += " ORDER BY created_at ASC"
        rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]

    def close_trade(self, trade_id: int, exit_time: float, pnl_sol: float, pnl_pct: float):
        """Mark a trade as closed with PnL data."""
        conn = self.connect()
        conn.execute(
            "UPDATE trades SET status='CLOSED', exit_time=?, pnl_sol=?, pnl_pct=? WHERE id=?",
            (exit_time, pnl_sol, pnl_pct, trade_id),
        )
        conn.commit()

    # ── ML Runs ──

    def insert_ml_run(self, run: Dict[str, Any]) -> int:
        """Log an ML training run."""
        conn = self.connect()
        cols = ", ".join(run.keys())
        placeholders = ", ".join(["?"] * len(run))
        cur = conn.execute(
            f"INSERT INTO ml_runs ({cols}) VALUES ({placeholders})",
            list(run.values()),
        )
        conn.commit()
        return cur.lastrowid

    # ── Utility ──

    def execute_raw(self, query: str, params: tuple = ()) -> List[Dict[str, Any]]:
        """Execute a raw SQL query and return results."""
        conn = self.connect()
        rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]


# ── Convenience singleton ──
_db: Optional[Database] = None


def get_db(db_path: str = DEFAULT_DB_PATH) -> Database:
    """Get or create a singleton Database instance."""
    global _db
    if _db is None or _db.db_path != db_path:
        _db = Database(db_path)
        _db.connect()
    return _db
