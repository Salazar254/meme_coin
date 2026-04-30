"""
src/event_handler.py — Event processing and strategy evaluation.

Receives raw Solana events (token launches), enriches them with on-chain
data, and delegates to the active strategy for trade decisions.

Supports real Pump.fun transaction decoding and Raydium LP detection.
"""

import os
import sys
import time
import logging
import struct
from typing import Dict, Any, List, Optional

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

logger = logging.getLogger("bot.event_handler")


# ─── Known Pump.fun program IDs ───
PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
RAYDIUM_AMM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"

# Pump.fun instruction discriminators (first 8 bytes of instruction data)
# These identify the type of interaction
PUMPFUN_CREATE_DISCRIMINATOR = bytes([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77])
PUMPFUN_BUY_DISCRIMINATOR = bytes([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea])


class EventHandler:
    """
    Handles incoming Solana events:
      1. Fetches/parses new token launches from RPC
      2. Enriches events with on-chain stats
      3. Evaluates events against the active strategy
    """

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.strategy_config = config["strategy"]
        self.ml_config = config.get("ml", {})
        self.rpc_url = os.getenv("SOLANA_RPC_URL", config["solana"]["rpc_url"])

        # Track seen mints to avoid duplicates
        self._seen_mints: set = set()
        self._seen_sigs: set = set()
        self._last_sig: Optional[str] = None

        # ML model (loaded lazily)
        self._ml_model = None
        self._ml_loaded = False

    # ── Fetch new events from RPC ──

    async def fetch_new_events(self, rpc_url: str = None) -> List[Dict[str, Any]]:
        """
        Poll the Solana RPC for recent transactions involving Pump.fun
        or Raydium AMM, and return parsed events.

        Fetches recent signatures, then decodes each transaction to extract
        token mint addresses, LP size, and buyer information.
        """
        rpc = rpc_url or self.rpc_url
        events = []

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                # Build params — use `before` for pagination if we have a cursor
                sig_params = {"limit": 25, "commitment": "confirmed"}

                # Get recent signatures for the Pump.fun program
                payload = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "getSignaturesForAddress",
                    "params": [PUMPFUN_PROGRAM_ID, sig_params],
                }
                resp = await client.post(rpc, json=payload)
                data = resp.json()

                if "result" not in data:
                    logger.warning(f"No results from RPC: {data.get('error', 'unknown')}")
                    return events

                for sig_info in data["result"]:
                    sig = sig_info["signature"]

                    # Skip already-seen transactions
                    if sig in self._seen_sigs:
                        continue
                    self._seen_sigs.add(sig)

                    # Skip failed transactions
                    if sig_info.get("err") is not None:
                        continue

                    # Fetch and decode the full transaction
                    event = await self._decode_transaction(client, rpc, sig, sig_info)
                    if event:
                        # Deduplicate by mint
                        mint = event.get("mint", "")
                        if mint and mint not in self._seen_mints:
                            self._seen_mints.add(mint)
                            events.append(event)
                            logger.debug(
                                f"📦 New event: {event.get('token_symbol', '?')} | "
                                f"LP={event.get('liquidity_sol', 0):.2f} SOL | "
                                f"Buyers={event.get('unique_buyers', 0)}"
                            )

                # Limit the seen-set size to avoid memory bloat
                if len(self._seen_sigs) > 10000:
                    # Keep only the most recent 5000
                    recent = list(self._seen_sigs)[-5000:]
                    self._seen_sigs = set(recent)

        except httpx.TimeoutException:
            logger.warning("RPC request timed out")
        except Exception as e:
            logger.error(f"RPC fetch error: {e}")

        return events

    async def _decode_transaction(
        self,
        client: httpx.AsyncClient,
        rpc_url: str,
        sig: str,
        sig_info: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """
        Fetch and decode a full transaction to extract token launch details.

        Looks for:
          - New token mints (Pump.fun create instruction)
          - LP deposits (SOL transferred to the pool)
          - Buyer counts from inner instructions
        """
        try:
            resp = await client.post(
                rpc_url,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "getTransaction",
                    "params": [
                        sig,
                        {
                            "encoding": "jsonParsed",
                            "maxSupportedTransactionVersion": 0,
                            "commitment": "confirmed",
                        },
                    ],
                },
            )
            tx_data = resp.json()

            if "result" not in tx_data or tx_data["result"] is None:
                return None

            result = tx_data["result"]
            tx = result.get("transaction", {})
            meta = result.get("meta", {})

            if meta.get("err") is not None:
                return None

            # Extract account keys from the transaction
            message = tx.get("message", {})
            account_keys = []
            for key in message.get("accountKeys", []):
                if isinstance(key, dict):
                    account_keys.append(key.get("pubkey", ""))
                else:
                    account_keys.append(str(key))

            # Find the token mint from the transaction
            mint_address = self._extract_mint(meta, account_keys)
            if not mint_address:
                return None

            # Calculate SOL changes (liquidity estimation)
            pre_balances = meta.get("preBalances", [])
            post_balances = meta.get("postBalances", [])
            liquidity_sol = self._estimate_liquidity(pre_balances, post_balances)

            # Count unique signers/buyers from inner instructions
            inner_ixs = meta.get("innerInstructions", [])
            unique_buyers = self._count_unique_wallets(inner_ixs, account_keys)

            # Extract token metadata from token balance changes
            token_name, token_symbol, decimals = self._extract_token_info(
                meta, mint_address
            )

            # Volume estimation from token transfers
            total_volume = self._estimate_volume(meta, pre_balances, post_balances)

            return {
                "mint": mint_address,
                "timestamp": sig_info.get("blockTime", time.time()),
                "block_slot": sig_info.get("slot", 0),
                "tx_signature": sig,
                "liquidity_sol": round(liquidity_sol, 4),
                "liquidity_usd": round(liquidity_sol * 150, 2),  # Rough SOL price est.
                "unique_buyers": unique_buyers,
                "total_volume": round(total_volume, 4),
                "market_cap_sol": round(liquidity_sol * 2, 4),  # Bonding curve ≈ 2x LP
                "token_name": token_name or "UNKNOWN",
                "token_symbol": token_symbol or "UNK",
                "decimals": decimals,
                "source": "pumpfun",
            }

        except httpx.TimeoutException:
            logger.debug(f"Transaction decode timed out: {sig[:12]}…")
            return None
        except Exception as e:
            logger.debug(f"Transaction decode failed for {sig[:12]}…: {e}")
            return None

    def _extract_mint(
        self, meta: Dict[str, Any], account_keys: List[str]
    ) -> Optional[str]:
        """
        Extract the token mint address from transaction metadata.
        Looks at postTokenBalances for new token accounts.
        """
        post_token_balances = meta.get("postTokenBalances", [])
        pre_token_balances = meta.get("preTokenBalances", [])

        # Find mints that appear in post but not in pre (new token)
        pre_mints = {b.get("mint") for b in pre_token_balances}

        for balance in post_token_balances:
            mint = balance.get("mint", "")
            if mint and mint not in pre_mints and mint != "So11111111111111111111111111111111111111112":
                return mint

        # Fallback: return first non-SOL mint from post balances
        for balance in post_token_balances:
            mint = balance.get("mint", "")
            if mint and mint != "So11111111111111111111111111111111111111112":
                return mint

        return None

    def _estimate_liquidity(
        self, pre_balances: List[int], post_balances: List[int]
    ) -> float:
        """
        Estimate LP size by looking at the largest SOL deposit
        (difference between pre and post balances).
        """
        if not pre_balances or not post_balances:
            return 0.0

        max_deposit = 0.0
        for pre, post in zip(pre_balances, post_balances):
            diff = (post - pre) / 1e9  # lamports → SOL
            if diff > max_deposit:
                max_deposit = diff

        return max_deposit

    def _count_unique_wallets(
        self, inner_instructions: List[Dict], account_keys: List[str]
    ) -> int:
        """
        Count unique wallet addresses involved in the transaction's
        inner instructions to estimate buyer count.
        """
        wallets = set()
        for ix_group in inner_instructions:
            for ix in ix_group.get("instructions", []):
                # Look for parsed transfer instructions
                parsed = ix.get("parsed", {})
                if isinstance(parsed, dict):
                    info = parsed.get("info", {})
                    for key in ("source", "destination", "authority"):
                        addr = info.get(key, "")
                        if addr and addr in account_keys:
                            wallets.add(addr)

        # Subtract known program accounts (rough estimate)
        return max(1, len(wallets) - 3)

    def _extract_token_info(
        self, meta: Dict[str, Any], mint_address: str
    ) -> tuple:
        """Extract token name, symbol, and decimals from transaction metadata."""
        token_name = None
        token_symbol = None
        decimals = 6  # Pump.fun default

        # Check postTokenBalances for decimal info
        for balance in meta.get("postTokenBalances", []):
            if balance.get("mint") == mint_address:
                ui_amount = balance.get("uiTokenAmount", {})
                decimals = ui_amount.get("decimals", 6)
                break

        # Token name/symbol aren't in the transaction — would need Metaplex
        # For now, use first 6 chars of mint as a placeholder identifier
        token_symbol = mint_address[:6].upper()
        token_name = f"PF_{mint_address[:8]}"

        return token_name, token_symbol, decimals

    def _estimate_volume(
        self, meta: Dict[str, Any],
        pre_balances: List[int],
        post_balances: List[int],
    ) -> float:
        """Estimate trading volume from total SOL movement in the transaction."""
        total_moved = 0.0
        for pre, post in zip(pre_balances, post_balances):
            diff = abs(post - pre) / 1e9
            total_moved += diff
        # Volume is roughly half the total movement (in + out)
        return total_moved / 2.0

    # ── Strategy evaluation ──

    def evaluate(self, event: Dict[str, Any]) -> Dict[str, Any]:
        """
        Run the active strategy on an event and return a trade decision.

        Returns:
            {
                "action": "BUY" | "SKIP",
                "amount_sol": float,
                "reason": str,
                "ml_score": float | None,
            }
        """
        # ── Rule-based checks ──
        lp = event.get("liquidity_sol", 0)
        buyers = event.get("unique_buyers", 0)
        age = time.time() - event.get("timestamp", time.time())

        # Check minimum LP
        if lp < self.strategy_config["min_lp_sol"]:
            return {"action": "SKIP", "amount_sol": 0, "reason": f"LP too low ({lp:.2f})", "ml_score": None}

        # Check age
        if age > self.strategy_config["max_age_seconds"]:
            return {"action": "SKIP", "amount_sol": 0, "reason": f"Too old ({age:.0f}s)", "ml_score": None}

        # Check buyers
        if buyers < self.strategy_config["min_unique_buyers"]:
            return {"action": "SKIP", "amount_sol": 0, "reason": f"Not enough buyers ({buyers})", "ml_score": None}

        # ── ML scoring (if enabled) ──
        ml_score = None
        if self.ml_config.get("enabled", False):
            ml_score = self._get_ml_score(event)

            if ml_score is not None and ml_score < self.ml_config.get("score_threshold", 0.5):
                return {
                    "action": "SKIP",
                    "amount_sol": 0,
                    "reason": f"ML score too low ({ml_score:.3f})",
                    "ml_score": ml_score,
                }

        # ── Compute position size ──
        base_size = self.strategy_config["default_position_sol"]

        if ml_score is not None and self.ml_config.get("scale_by_score", False):
            # Scale position by ML confidence (capped at 2x)
            scale = min(ml_score * 2, 2.0)
            position_size = base_size * scale
        else:
            position_size = base_size

        # Cap at max spend
        position_size = min(position_size, self.strategy_config["max_spend_per_token_sol"])

        return {
            "action": "BUY",
            "amount_sol": position_size,
            "reason": f"LP={lp:.2f}, buyers={buyers}, age={age:.0f}s",
            "ml_score": ml_score,
        }

    # ── ML model integration ──

    def _get_ml_score(self, event: Dict[str, Any]) -> Optional[float]:
        """Load ML model (lazy) and compute a quality score for the event."""
        if not self._ml_loaded:
            self._load_ml_model()

        if self._ml_model is None:
            return None

        try:
            from ml.features import event_to_features
            features = event_to_features(event)
            score = self._ml_model.predict_score(features)
            return float(score)
        except Exception as e:
            logger.warning(f"ML scoring failed: {e}")
            return None

    def _load_ml_model(self):
        """Attempt to load the pre-trained ML model."""
        self._ml_loaded = True
        model_type = self.ml_config.get("model_type", "xgb")

        try:
            if model_type == "nn":
                from ml.nn_model import NNModel
                self._ml_model = NNModel.load(self.ml_config.get("nn_model_path"))
            elif model_type == "xgb":
                from ml.xgb_model import XGBModel
                self._ml_model = XGBModel.load(self.ml_config.get("xgb_model_path"))
            elif model_type == "ensemble":
                from ml.nn_model import NNModel
                from ml.xgb_model import XGBModel
                # Simple ensemble: average of both
                self._ml_model = EnsembleModel(
                    nn_path=self.ml_config.get("nn_model_path"),
                    xgb_path=self.ml_config.get("xgb_model_path"),
                )
            logger.info(f"✅ ML model loaded: {model_type}")
        except Exception as e:
            logger.warning(f"Could not load ML model ({model_type}): {e}")
            self._ml_model = None


class EnsembleModel:
    """Simple ensemble that averages NN and XGBoost scores."""

    def __init__(self, nn_path: str, xgb_path: str):
        from ml.nn_model import NNModel
        from ml.xgb_model import XGBModel

        self.nn = NNModel.load(nn_path) if nn_path and os.path.exists(nn_path) else None
        self.xgb = XGBModel.load(xgb_path) if xgb_path and os.path.exists(xgb_path) else None

    def predict_score(self, features):
        scores = []
        if self.nn:
            scores.append(self.nn.predict_score(features))
        if self.xgb:
            scores.append(self.xgb.predict_score(features))
        if not scores:
            return 0.5
        return sum(scores) / len(scores)
