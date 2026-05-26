"""
src/wallet.py — Solana wallet management + Jupiter V6 swap integration.

Handles keypair loading, balance checking, and real on-chain swaps
via the Jupiter Aggregator V6 API.

Only used in LIVE mode — backtest and dry-run never touch this.

⚠️  SECURITY: Never commit your private key. Use .env or secure key storage.
"""

import os
import json
import base64
import logging
import time
from typing import Optional, Dict, Any

import httpx

logger = logging.getLogger("bot.wallet")

# ─── Jupiter V6 API endpoints ───
JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote"
JUPITER_SWAP_URL = "https://quote-api.jup.ag/v6/swap"

# Solana native SOL mint address (wrapped SOL)
SOL_MINT = "So11111111111111111111111111111111111111112"

# Solana RPC for sending transactions
DEFAULT_RPC = "https://api.mainnet-beta.solana.com"


class WalletManager:
    """
    Manages a Solana wallet for live trading.

    Loads the keypair from:
      1. WALLET_PRIVATE_KEY env var (base58)
      2. WALLET_KEYPAIR_PATH env var (JSON file)

    Executes real on-chain swaps via Jupiter V6 Aggregator API.
    """

    def __init__(self):
        self.keypair = None
        self.public_key = None
        self.rpc_url = os.getenv("SOLANA_RPC_URL", DEFAULT_RPC)
        self._load_keypair()

    def _load_keypair(self):
        """Load wallet keypair from environment."""
        # Try base58 private key first
        privkey_b58 = os.getenv("WALLET_PRIVATE_KEY")
        keypair_path = os.getenv("WALLET_KEYPAIR_PATH")

        if privkey_b58:
            try:
                from solders.keypair import Keypair  # type: ignore
                self.keypair = Keypair.from_base58_string(privkey_b58)
                self.public_key = str(self.keypair.pubkey())
                logger.info(f"🔑 Wallet loaded from env: {self.public_key[:8]}…")
            except ImportError:
                logger.warning(
                    "solders not installed — wallet operations won't work. "
                    "Install with: pip install solders"
                )
            except Exception as e:
                logger.error(f"Failed to load keypair from WALLET_PRIVATE_KEY: {e}")

        elif keypair_path and os.path.exists(keypair_path):
            try:
                from solders.keypair import Keypair  # type: ignore
                with open(keypair_path, "r") as f:
                    key_bytes = bytes(json.load(f))
                self.keypair = Keypair.from_bytes(key_bytes)
                self.public_key = str(self.keypair.pubkey())
                logger.info(f"🔑 Wallet loaded from file: {self.public_key[:8]}…")
            except ImportError:
                logger.warning("solders not installed — install with: pip install solders")
            except Exception as e:
                logger.error(f"Failed to load keypair from {keypair_path}: {e}")

        else:
            logger.warning(
                "⚠️  No wallet configured. Set WALLET_PRIVATE_KEY or "
                "WALLET_KEYPAIR_PATH in your .env file for LIVE mode."
            )

    # ── Balance ──

    async def get_balance(self, rpc_url: str = None) -> float:
        """Fetch the SOL balance of the loaded wallet."""
        if not self.public_key:
            return 0.0

        rpc = rpc_url or self.rpc_url

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    rpc,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "getBalance",
                        "params": [self.public_key],
                    },
                )
                data = resp.json()
                lamports = data.get("result", {}).get("value", 0)
                return lamports / 1e9  # Convert lamports to SOL
        except Exception as e:
            logger.error(f"Failed to get balance: {e}")
            return 0.0

    async def get_token_balance(self, mint_address: str) -> float:
        """Fetch the token balance for a given mint in the wallet."""
        if not self.public_key:
            return 0.0

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    self.rpc_url,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "getTokenAccountsByOwner",
                        "params": [
                            self.public_key,
                            {"mint": mint_address},
                            {"encoding": "jsonParsed"},
                        ],
                    },
                )
                data = resp.json()
                accounts = data.get("result", {}).get("value", [])
                if not accounts:
                    return 0.0

                # Sum all token accounts for this mint
                total = 0.0
                for acc in accounts:
                    info = acc.get("account", {}).get("data", {}).get("parsed", {}).get("info", {})
                    amount = info.get("tokenAmount", {})
                    total += float(amount.get("uiAmount", 0))
                return total
        except Exception as e:
            logger.error(f"Failed to get token balance for {mint_address[:12]}…: {e}")
            return 0.0

    # ── Jupiter V6 Swap: BUY (SOL → Token) ──

    def send_swap(
        self,
        mint_address: str,
        amount_sol: float,
        slippage_bps: int = 200,
    ) -> str:
        """
        Buy a token by swapping SOL → token via Jupiter V6 API.

        Args:
            mint_address: Token mint to buy
            amount_sol: Amount of SOL to spend
            slippage_bps: Slippage tolerance in basis points (200 = 2%)

        Returns:
            Transaction signature string

        Raises:
            RuntimeError: If wallet not loaded or swap fails
        """
        if not self.keypair:
            raise RuntimeError("No wallet keypair loaded")

        # Jupiter expects amounts in lamports (1 SOL = 1e9 lamports)
        amount_lamports = int(amount_sol * 1e9)

        logger.info(
            f"🔄 BUY Swap: {amount_sol:.4f} SOL → {mint_address[:12]}… "
            f"(slippage: {slippage_bps}bps)"
        )

        return self._execute_jupiter_swap(
            input_mint=SOL_MINT,
            output_mint=mint_address,
            amount=amount_lamports,
            slippage_bps=slippage_bps,
        )

    # ── Jupiter V6 Swap: SELL (Token → SOL) ──

    def send_sell(
        self,
        mint_address: str,
        token_amount: int,
        token_decimals: int = 6,
        slippage_bps: int = 300,
    ) -> str:
        """
        Sell a token by swapping token → SOL via Jupiter V6 API.

        Args:
            mint_address: Token mint to sell
            token_amount: Raw token amount (in smallest unit)
            token_decimals: Token decimal places (for logging only)
            slippage_bps: Slippage tolerance in basis points (300 = 3%)

        Returns:
            Transaction signature string
        """
        if not self.keypair:
            raise RuntimeError("No wallet keypair loaded")

        display_amount = token_amount / (10 ** token_decimals)
        logger.info(
            f"🔄 SELL Swap: {display_amount:.4f} tokens ({mint_address[:12]}…) → SOL "
            f"(slippage: {slippage_bps}bps)"
        )

        return self._execute_jupiter_swap(
            input_mint=mint_address,
            output_mint=SOL_MINT,
            amount=token_amount,
            slippage_bps=slippage_bps,
        )

    # ── Core Jupiter swap execution ──

    def _execute_jupiter_swap(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        slippage_bps: int,
    ) -> str:
        """
        Execute a swap through Jupiter V6 API.

        Steps:
          1. Get a quote (best route) from Jupiter
          2. Request a serialized swap transaction
          3. Deserialize, sign with our keypair
          4. Send the raw signed transaction to RPC
          5. Confirm and return the tx signature

        Returns:
            Transaction signature (base58 string)
        """
        import httpx as httpx_sync

        # ── Step 1: Get quote ──
        quote_params = {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(amount),
            "slippageBps": str(slippage_bps),
            "onlyDirectRoutes": "false",
            "asLegacyTransaction": "false",
        }

        logger.debug(f"  Jupiter quote request: {quote_params}")

        with httpx_sync.Client(timeout=15) as client:
            quote_resp = client.get(JUPITER_QUOTE_URL, params=quote_params)

            if quote_resp.status_code != 200:
                raise RuntimeError(
                    f"Jupiter quote failed (HTTP {quote_resp.status_code}): "
                    f"{quote_resp.text[:200]}"
                )

            quote_data = quote_resp.json()

            if "error" in quote_data:
                raise RuntimeError(f"Jupiter quote error: {quote_data['error']}")

            out_amount = int(quote_data.get("outAmount", 0))
            price_impact = quote_data.get("priceImpactPct", "?")
            logger.info(
                f"  📊 Quote: {amount} → {out_amount} | "
                f"Price impact: {price_impact}%"
            )

            # ── Step 2: Get swap transaction ──
            swap_payload = {
                "quoteResponse": quote_data,
                "userPublicKey": self.public_key,
                "wrapAndUnwrapSol": True,
                "dynamicComputeUnitLimit": True,
                "prioritizationFeeLamports": "auto",
            }

            swap_resp = client.post(JUPITER_SWAP_URL, json=swap_payload)

            if swap_resp.status_code != 200:
                raise RuntimeError(
                    f"Jupiter swap failed (HTTP {swap_resp.status_code}): "
                    f"{swap_resp.text[:200]}"
                )

            swap_data = swap_resp.json()

            if "error" in swap_data:
                raise RuntimeError(f"Jupiter swap error: {swap_data['error']}")

        # ── Step 3: Sign the transaction ──
        swap_tx_b64 = swap_data.get("swapTransaction")
        if not swap_tx_b64:
            raise RuntimeError("No swapTransaction in Jupiter response")

        tx_sig = self._sign_and_send(swap_tx_b64)
        return tx_sig

    def _sign_and_send(self, swap_tx_b64: str) -> str:
        """
        Deserialize a base64 versioned transaction, sign it,
        and send it to the Solana RPC.

        Returns:
            Transaction signature (base58 string)
        """
        from solders.transaction import VersionedTransaction  # type: ignore
        from solders.keypair import Keypair  # type: ignore

        # Decode the base64 transaction
        tx_bytes = base64.b64decode(swap_tx_b64)
        tx = VersionedTransaction.from_bytes(tx_bytes)

        # Sign the transaction
        # VersionedTransaction needs to be re-created with the signature
        signed_tx = VersionedTransaction(tx.message, [self.keypair])

        # Serialize the signed transaction
        signed_bytes = bytes(signed_tx)
        signed_b64 = base64.b64encode(signed_bytes).decode("utf-8")

        # Send via RPC
        with httpx.Client(timeout=30) as client:
            send_resp = client.post(
                self.rpc_url,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "sendTransaction",
                    "params": [
                        signed_b64,
                        {
                            "encoding": "base64",
                            "skipPreflight": True,
                            "preflightCommitment": "confirmed",
                            "maxRetries": 3,
                        },
                    ],
                },
            )
            result = send_resp.json()

        if "error" in result:
            raise RuntimeError(
                f"sendTransaction failed: {result['error'].get('message', result['error'])}"
            )

        tx_sig = result.get("result", "")
        logger.info(f"  📤 Transaction sent: {tx_sig[:20]}…")

        # ── Confirm the transaction ──
        self._confirm_transaction(tx_sig)

        return tx_sig

    def _confirm_transaction(self, tx_sig: str, timeout: int = 60):
        """
        Poll RPC until the transaction is confirmed or timeout.
        """
        logger.debug(f"  ⏳ Confirming tx: {tx_sig[:20]}…")
        start = time.time()

        with httpx.Client(timeout=10) as client:
            while time.time() - start < timeout:
                try:
                    resp = client.post(
                        self.rpc_url,
                        json={
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "getSignatureStatuses",
                            "params": [[tx_sig]],
                        },
                    )
                    data = resp.json()
                    statuses = data.get("result", {}).get("value", [])

                    if statuses and statuses[0] is not None:
                        status = statuses[0]
                        if status.get("err"):
                            raise RuntimeError(
                                f"Transaction failed on-chain: {status['err']}"
                            )
                        conf = status.get("confirmationStatus", "")
                        if conf in ("confirmed", "finalized"):
                            logger.info(f"  ✅ Transaction confirmed: {conf}")
                            return
                except Exception as e:
                    logger.debug(f"  Confirmation poll error: {e}")

                time.sleep(2)

        logger.warning(f"  ⚠️ Transaction confirmation timed out after {timeout}s")

    # ── Price fetching for position monitoring ──

    async def get_token_price_sol(self, mint_address: str) -> float:
        """
        Get the current price of a token in SOL using Jupiter quote API.

        Quotes a swap of 1 SOL → token to determine the exchange rate,
        then inverts it.
        """
        try:
            # Quote 1 SOL worth of the token
            one_sol = 1_000_000_000  # 1 SOL in lamports
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    JUPITER_QUOTE_URL,
                    params={
                        "inputMint": SOL_MINT,
                        "outputMint": mint_address,
                        "amount": str(one_sol),
                        "slippageBps": "100",
                    },
                )
                if resp.status_code != 200:
                    return 0.0

                data = resp.json()
                out_amount = int(data.get("outAmount", 0))
                if out_amount <= 0:
                    return 0.0

                # Price per token in SOL = 1 SOL / tokens_received
                # (this gives us how much SOL one token is worth)
                return 1.0 / (out_amount / 1e6)  # Assume 6 decimals for meme tokens

        except Exception as e:
            logger.debug(f"Price fetch failed for {mint_address[:12]}…: {e}")
            return 0.0
