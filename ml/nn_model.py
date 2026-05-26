"""
ml/nn_model.py - Small PyTorch MLP for probability or soft-return prediction.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset

logger = logging.getLogger("ml.nn_model")


class MemeScoreNet(nn.Module):
    def __init__(self, input_dim: int = 18, hidden_dims: list = None, dropout: float = 0.25, task: str = "regression"):
        super().__init__()
        hidden_dims = hidden_dims or [64, 32, 16]
        layers = []
        prev_dim = input_dim
        for hidden_dim in hidden_dims:
            layers.extend([
                nn.Linear(prev_dim, hidden_dim),
                nn.BatchNorm1d(hidden_dim),
                nn.ReLU(),
                nn.Dropout(dropout),
            ])
            prev_dim = hidden_dim
        layers.append(nn.Linear(prev_dim, 1))
        self.body = nn.Sequential(*layers)
        self.task = task

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        output = self.body(x).squeeze(-1)
        if self.task in {"classification", "probability"}:
            return torch.sigmoid(output)
        return output


class NNModel:
    def __init__(
        self,
        input_dim: int = 18,
        hidden_dims: list = None,
        dropout: float = 0.25,
        lr: float = 1e-3,
        weight_decay: float = 1e-4,
        task: str = "regression",
    ):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.task = task
        self.model = MemeScoreNet(input_dim, hidden_dims, dropout, task).to(self.device)
        self.optimizer = optim.Adam(self.model.parameters(), lr=lr, weight_decay=weight_decay)
        self.criterion = nn.BCELoss() if task in {"classification", "probability"} else nn.SmoothL1Loss()
        self.history: Dict[str, Any] = {"train_loss": [], "val_loss": []}
        self.metadata = {
            "input_dim": input_dim,
            "hidden_dims": hidden_dims or [64, 32, 16],
            "dropout": dropout,
            "lr": lr,
            "weight_decay": weight_decay,
            "task": task,
        }

    def train_model(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray = None,
        y_val: np.ndarray = None,
        epochs: int = 50,
        batch_size: int = 64,
        early_stopping_patience: int = 10,
    ) -> Dict[str, Any]:
        train_ds = TensorDataset(torch.FloatTensor(X_train), torch.FloatTensor(y_train))
        train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
        has_val = X_val is not None and len(X_val) > 0

        best_state = None
        best_val_loss = float("inf")
        patience = 0

        for _ in range(epochs):
            self.model.train()
            train_losses = []
            for X_batch, y_batch in train_loader:
                X_batch = X_batch.to(self.device)
                y_batch = y_batch.to(self.device)
                self.optimizer.zero_grad()
                preds = self.model(X_batch)
                loss = self.criterion(preds, y_batch)
                loss.backward()
                self.optimizer.step()
                train_losses.append(loss.item())

            train_loss = float(np.mean(train_losses)) if train_losses else 0.0
            self.history["train_loss"].append(train_loss)

            if has_val:
                val_loss = self._evaluate_loss(X_val, y_val)
                self.history["val_loss"].append(val_loss)
                if val_loss < best_val_loss:
                    best_val_loss = val_loss
                    best_state = {k: v.detach().cpu().clone() for k, v in self.model.state_dict().items()}
                    patience = 0
                else:
                    patience += 1
                    if patience >= early_stopping_patience:
                        break

        if best_state is not None:
            self.model.load_state_dict(best_state)
        return self.history

    def _evaluate_loss(self, X: np.ndarray, y: np.ndarray) -> float:
        self.model.eval()
        with torch.no_grad():
            X_tensor = torch.FloatTensor(X).to(self.device)
            y_tensor = torch.FloatTensor(y).to(self.device)
            preds = self.model(X_tensor)
            return float(self.criterion(preds, y_tensor).item())

    def predict_score(self, features: np.ndarray) -> float:
        if features.ndim == 1:
            features = features.reshape(1, -1)
        value = float(self.predict_batch(features)[0])
        if self.task == "regression":
            return float(1.0 / (1.0 + np.exp(-value * 2.0)))
        return value

    def predict_batch(self, X: np.ndarray) -> np.ndarray:
        self.model.eval()
        with torch.no_grad():
            X_tensor = torch.FloatTensor(X).to(self.device)
            preds = self.model(X_tensor).detach().cpu().numpy()
        return preds

    def save(self, path: str = "ml/saved_models/nn_model.pt"):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        torch.save({"state_dict": self.model.state_dict(), "metadata": self.metadata, "history": self.history}, path)
        meta_path = path.replace(".pt", "_meta.json")
        with open(meta_path, "w", encoding="utf-8") as handle:
            json.dump({"metadata": self.metadata, "history": self.history}, handle, indent=2)

    @classmethod
    def load(cls, path: str = "ml/saved_models/nn_model.pt") -> "NNModel":
        if not os.path.exists(path):
            raise FileNotFoundError(path)
        payload = torch.load(path, map_location="cpu")
        metadata = payload.get("metadata", {})
        model = cls(
            input_dim=metadata.get("input_dim", 18),
            hidden_dims=metadata.get("hidden_dims"),
            dropout=metadata.get("dropout", 0.25),
            lr=metadata.get("lr", 1e-3),
            weight_decay=metadata.get("weight_decay", 1e-4),
            task=metadata.get("task", "regression"),
        )
        model.model.load_state_dict(payload["state_dict"])
        model.history = payload.get("history", {})
        return model
