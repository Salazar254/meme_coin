"""
src/log_setup.py — Centralized logging setup.

Handles Unicode-safe logging on Windows (cp1252 console)
by using Rich with forced UTF-8 output.
"""

import os
import sys
import logging

# Force UTF-8 output on Windows to avoid emoji encoding errors
if sys.platform == "win32":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from rich.console import Console
from rich.logging import RichHandler

# Create a Unicode-safe console
console = Console(force_terminal=True, force_jupyter=False)


def setup_logging(level: str = "INFO") -> logging.Logger:
    """Configure root logger with Rich handler (Unicode-safe on Windows)."""
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(message)s",
        datefmt="[%X]",
        handlers=[RichHandler(
            console=console,
            rich_tracebacks=True,
            markup=True,
            show_path=False,
        )],
        force=True,
    )
    return logging.getLogger("bot")
