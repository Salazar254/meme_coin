"""Compatibility wrapper for the production PyTorch/ONNX trainer."""

from __future__ import annotations

import os
import runpy
import sys


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ML_DIR = os.path.join(ROOT, "ml")
sys.path.insert(0, ML_DIR)
sys.path.insert(0, ROOT)

runpy.run_path(os.path.join(ML_DIR, "train_rug_model.py"), run_name="__main__")
