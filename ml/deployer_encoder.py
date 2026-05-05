"""Deployer embedding pre-training with triplet contrastive loss."""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from typing import Iterable

try:
    import torch
    from torch import nn
    from torch.utils.data import DataLoader, Dataset
except ModuleNotFoundError as exc:  # pragma: no cover - exercised by CLI envs.
    raise SystemExit(
        "PyTorch is required for deployer embedding training. "
        "Install ml/requirements.txt, then rerun this command."
    ) from exc


EMBEDDING_DIM = 32


class DeployerEncoder(nn.Module):
    def __init__(self, num_deployers: int, embedding_dim: int = EMBEDDING_DIM):
        super().__init__()
        self.embedding = nn.Embedding(num_deployers, embedding_dim)
        nn.init.normal_(self.embedding.weight, mean=0.0, std=0.02)

    def forward(self, deployer_ids: torch.Tensor) -> torch.Tensor:
        return self.embedding(deployer_ids.long())


@dataclass(frozen=True)
class DeployerOutcome:
    deployer: str
    outcome_bucket: str
    timestamp_ms: int


class TripletDeployerDataset(Dataset[tuple[int, int, int]]):
    def __init__(self, outcomes: list[DeployerOutcome], deployer_to_id: dict[str, int]):
        self.deployer_to_id = deployer_to_id
        by_bucket: dict[str, list[str]] = {}
        for item in outcomes:
            by_bucket.setdefault(item.outcome_bucket, []).append(item.deployer)

        triplets: list[tuple[int, int, int]] = []
        buckets = sorted(by_bucket)
        for bucket in buckets:
            positives = list(dict.fromkeys(by_bucket[bucket]))
            negatives = list(dict.fromkeys(
                deployer for other in buckets if other != bucket for deployer in by_bucket[other]
            ))
            if len(positives) < 2 or not negatives:
                continue
            for index, anchor in enumerate(positives):
                positive = positives[(index + 1) % len(positives)]
                negative = negatives[index % len(negatives)]
                triplets.append((
                    deployer_to_id[anchor],
                    deployer_to_id[positive],
                    deployer_to_id[negative],
                ))
        self.triplets = triplets

    def __len__(self) -> int:
        return len(self.triplets)

    def __getitem__(self, index: int) -> tuple[int, int, int]:
        return self.triplets[index]


def load_outcomes(path: str, lookback_days: int = 183) -> list[DeployerOutcome]:
    rows: list[DeployerOutcome] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            payload = json.loads(line)
            deployer = str(payload.get("deployer") or payload.get("creator") or "")
            if not deployer:
                continue
            timestamp = int(payload.get("timestamp_ms") or payload.get("timestamp") or 0)
            if timestamp and timestamp < 10_000_000_000:
                timestamp *= 1000
            label = payload.get("rug_label")
            pump = payload.get("pump_2x")
            if label in {1, True, "1", "true", "rug"}:
                bucket = "rug"
            elif pump in {1, True, "1", "true", "pump"}:
                bucket = "pump"
            else:
                bucket = "neutral"
            rows.append(DeployerOutcome(deployer=deployer, outcome_bucket=bucket, timestamp_ms=timestamp))

    if not rows:
        return rows
    newest = max(item.timestamp_ms for item in rows)
    cutoff = newest - lookback_days * 86_400_000
    return [item for item in rows if item.timestamp_ms >= cutoff]


def pretrain_deployer_embeddings(
    outcomes: Iterable[DeployerOutcome],
    output_path: str = "models/deployer_embeddings.pt",
    epochs: int = 25,
    batch_size: int = 256,
    lr: float = 1e-3,
) -> dict[str, object]:
    data = list(outcomes)
    deployers = sorted({item.deployer for item in data})
    deployer_to_id = {deployer: index for index, deployer in enumerate(deployers)}
    dataset = TripletDeployerDataset(data, deployer_to_id)
    if len(dataset) == 0:
        raise ValueError("not_enough_deployer_triplets")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = DeployerEncoder(max(len(deployers), 1)).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    criterion = nn.TripletMarginLoss(margin=0.35)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    history: list[float] = []
    for _ in range(epochs):
        model.train()
        losses: list[float] = []
        for anchor, positive, negative in loader:
            anchor = anchor.to(device)
            positive = positive.to(device)
            negative = negative.to(device)
            optimizer.zero_grad()
            loss = criterion(model(anchor), model(positive), model(negative))
            loss.backward()
            optimizer.step()
            losses.append(float(loss.detach().cpu()))
        history.append(sum(losses) / max(len(losses), 1))

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    torch.save(
        {
            "state_dict": model.state_dict(),
            "deployer_to_id": deployer_to_id,
            "embedding_dim": EMBEDDING_DIM,
            "history": history,
        },
        output_path,
    )
    return {
        "output_path": output_path,
        "num_deployers": len(deployers),
        "triplets": len(dataset),
        "final_loss": history[-1],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="JSONL deployer outcome history")
    parser.add_argument("--output", default="models/deployer_embeddings.pt")
    parser.add_argument("--epochs", type=int, default=25)
    args = parser.parse_args()
    summary = pretrain_deployer_embeddings(load_outcomes(args.input), args.output, args.epochs)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
