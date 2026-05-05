"""GRU encoder for hourly token state sequences.

The main rug model consumes a 24 step history of knowable market state. Each
step has:

holder_count, liquidity_sol, volume_sol, buy_sell_ratio, price_velocity
"""

from __future__ import annotations

import torch
from torch import nn


SEQUENCE_LENGTH = 24
SEQUENCE_FEATURES = [
    "holder_count",
    "liquidity_sol",
    "volume_sol",
    "buy_sell_ratio",
    "price_velocity",
]


class SequenceEncoder(nn.Module):
    """Encode 24 hourly snapshots into a compact temporal embedding."""

    def __init__(self, input_dim: int = 5, hidden_dim: int = 16, num_layers: int = 1):
        super().__init__()
        self.input_dim = input_dim
        self.hidden_dim = hidden_dim
        self.gru = nn.GRU(
            input_size=input_dim,
            hidden_size=hidden_dim,
            num_layers=num_layers,
            batch_first=True,
        )

    def forward(self, sequence: torch.Tensor) -> torch.Tensor:
        if sequence.ndim != 3:
            raise ValueError("sequence tensor must be [batch, 24, 5]")
        _, hidden = self.gru(sequence)
        return hidden[-1]
