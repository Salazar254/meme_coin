-- ─── Solana Meme-Coin Bot: Database Schema ───
-- Events table: stores each detected token launch event

CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    mint            TEXT NOT NULL,                    -- Token mint address
    timestamp       REAL NOT NULL,                    -- Unix timestamp (float, ms precision)
    block_slot      INTEGER,                          -- Solana slot number
    tx_signature    TEXT,                             -- Transaction signature
    
    -- On-chain stats at detection time
    liquidity_sol   REAL DEFAULT 0.0,                -- LP pool size in SOL
    liquidity_usd   REAL DEFAULT 0.0,                -- LP pool size in USD
    unique_buyers   INTEGER DEFAULT 0,               -- Number of unique buyer wallets
    total_volume    REAL DEFAULT 0.0,                 -- Total volume in SOL
    market_cap_sol  REAL DEFAULT 0.0,                -- Market cap in SOL
    
    -- Metadata
    token_name      TEXT,                             -- Token name/ticker
    token_symbol    TEXT,                             -- Token symbol
    decimals        INTEGER DEFAULT 9,                -- Token decimals
    source          TEXT DEFAULT 'pumpfun',           -- Event source (pumpfun, raydium, etc.)
    
    -- Price snapshots (filled asynchronously)
    price_1m        REAL,                             -- Price after 1 minute
    price_5m        REAL,                             -- Price after 5 minutes
    price_10m       REAL,                             -- Price after 10 minutes
    price_30m       REAL,                             -- Price after 30 minutes
    price_1h        REAL,                             -- Price after 1 hour
    
    -- PnL labels (computed post-hoc for ML)
    pnl_1m          REAL,                             -- Profit/loss after 1 minute
    pnl_5m          REAL,                             -- Profit/loss after 5 minutes
    pnl_10m         REAL,                             -- Profit/loss after 10 minutes
    is_10x          INTEGER DEFAULT 0,                -- Did it 10x within 1 hour? (0/1)
    is_100x         INTEGER DEFAULT 0,                -- Did it 100x within 1 hour? (0/1)
    
    created_at      TEXT DEFAULT (datetime('now'))
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_mint ON events(mint);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);

-- Trades table: tracks all bot trades (backtest and live)
CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        INTEGER REFERENCES events(id),
    mint            TEXT NOT NULL,
    mode            TEXT NOT NULL,                    -- BACKTEST, DRY_RUN, LIVE
    
    -- Trade details
    side            TEXT NOT NULL,                    -- BUY or SELL
    amount_sol      REAL NOT NULL,                    -- Amount in SOL
    price           REAL,                             -- Execution price
    slippage        REAL DEFAULT 0.0,                 -- Actual slippage
    gas_cost        REAL DEFAULT 0.0,                 -- Gas/priority fee
    
    -- Timestamps
    entry_time      REAL,                             -- Entry timestamp
    exit_time       REAL,                             -- Exit timestamp
    
    -- Results
    pnl_sol         REAL,                             -- Realized PnL in SOL
    pnl_pct         REAL,                             -- Realized PnL percentage
    
    -- ML score at time of trade
    ml_score        REAL,                             -- ML quality score (0-1)
    strategy_name   TEXT DEFAULT 'rule_based',        -- Which strategy triggered this
    
    -- Execution
    tx_signature    TEXT,                             -- On-chain tx sig (live only)
    status          TEXT DEFAULT 'OPEN',              -- OPEN, CLOSED, FAILED
    
    created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades(mode);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

-- ML training runs: track model versions and metrics
CREATE TABLE IF NOT EXISTS ml_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    model_type      TEXT NOT NULL,                    -- nn, xgb, ensemble
    train_start     TEXT,                             -- Training window start
    train_end       TEXT,                             -- Training window end
    val_start       TEXT,                             -- Validation window start
    val_end         TEXT,                             -- Validation window end
    
    -- Metrics
    train_sharpe    REAL,
    val_sharpe      REAL,
    train_winrate   REAL,
    val_winrate     REAL,
    train_max_dd    REAL,
    val_max_dd      REAL,
    
    -- Overfit check
    overfit_warning TEXT,                              -- Warning message if detected
    
    model_path      TEXT,                             -- Path to saved model file
    created_at      TEXT DEFAULT (datetime('now'))
);
