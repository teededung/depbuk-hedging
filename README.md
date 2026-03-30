# DeepBook Hedging Bot

DeepBook hedging bot on Sui built on top of the current SvelteKit starter. It runs a server-side bot loop with two separate accounts and a realtime dashboard that mirrors the requested dark trading layout.

> **⚠️ Cảnh báo bảo mật / Security Warning**
>
> Dự án này được xây dựng với mục đích học tập và nghiên cứu DeFi. Chỉ nên chạy trên `localhost` — **không triển khai lên server công khai** để tránh lộ private key và tài sản của bạn.
>
> This project is built for DeFi learning and research purposes only. Run on `localhost` only — **do not deploy to a public server** to protect your private keys and funds.
>
> Tác giả không chịu trách nhiệm cho bất kỳ tổn thất tài chính nào phát sinh từ việc sử dụng phần mềm này. Sử dụng hoàn toàn trên rủi ro của bạn.
>
> The author assumes no liability for any financial losses arising from the use of this software. Use entirely at your own risk.

## What it does

- Uses two isolated accounts:
  - `Account A (Long)`
  - `Account B (Short)`
- Runs paired hedging cycles:
  - place maker `POST_ONLY` limit long on account A
  - place maker `POST_ONLY` limit short on account B
  - wait for full fills, with automatic cancel/reprice if they sit too long
  - hold for a random time between `min_hold_seconds` and `max_hold_seconds`
  - place opposite maker orders to close both legs
  - withdraw settled balances, repay margin debt if used, and withdraw remaining collateral
- Persists cycle history and logs in Postgres
- Streams live state to the dashboard through SSE
- Can auto-topup balances with 7K Meta Aggregator before opening a cycle:
  - swap `SUI -> USDC` on `Account A` if quote collateral is short
  - swap `USDC -> SUI` on `Account B` if base collateral or gas reserve is short
- Supports `Stop & Clean`:
  - stop the loop
  - cancel open orders
  - attempt to flatten residual positions
  - clear cycle/log database state

## Stack

- `SvelteKit 2` + `Svelte 5`
- `Tailwind CSS 4` + `daisyUI`
- `@mysten/sui`
- `@mysten/deepbook-v3` builders/constants
- `pg` for Postgres
- `@sveltejs/adapter-node` for a long-running bot server

## Important behavior

- The bot runs on the server, not in the browser.
- It auto-creates the local Postgres database from `DATABASE_URL` if the database itself does not exist yet.
- Bot settings are stored in Postgres and edited from the dashboard Settings modal.
- Private keys are encrypted at rest with `BOT_SETTINGS_MASTER_KEY`.
- It auto-creates margin managers on-chain if `account_a_margin_manager_id` or `account_b_margin_manager_id` are empty.
- If required keys are not configured in settings yet, the app stays in `CONFIG_REQUIRED` instead of crashing.
- The current implementation supports optional borrowing factors:
  - `account_a_borrow_quote_factor`
  - `account_b_borrow_base_factor`
  - set them to `1` for unlevered spot-style hedge cycles
  - set them above `1` to increase exposure before the order is placed
- If `auto_swap_enabled` is on, the bot tries to top up missing wallet collateral via `@7kprotocol/sdk-ts` before submitting maker orders.

## Prerequisites

- Node.js 20+
- pnpm
- PostgreSQL running locally
- Two funded Sui accounts with the assets needed for the chosen cycle flow

## Install

```bash
pnpm install
cp .env.example .env
```

Edit `.env`:

```env
DATABASE_URL=postgresql://localhost:5432/deepbook_hedging
BOT_SETTINGS_MASTER_KEY=change-me-to-a-long-random-secret
```

## Configure

Open the dashboard and use the `Settings` button in the topbar.

The first boot seeds one global settings record in Postgres with defaults such as:

- `network: mainnet`
- `rpc_url`: two default RPC endpoints (newline-separated):
  - `https://fullnode.mainnet.sui.io:443`
  - `https://sui-rpc.publicnode.com/`
- `deeptrade_orderbook_api_base: https://api.deeptrade.space/api`
- `pool_key: SUI_USDC`
- `notional_size_usd: 10`
- `min_hold_seconds: 150`
- `max_hold_seconds: 210`
- `max_cycles: 3`
- `slippage_tolerance: 0.003`
- `account_a_borrow_quote_factor: 2`
- `account_b_borrow_base_factor: 2`

You must still configure:

- `private_key_A`
- `private_key_B`

Leaving a private-key field blank in the Settings modal keeps the stored encrypted key unchanged.

## Run

Development:

```bash
pnpm dev
```

Production:

```bash
pnpm build
pnpm start
```

Open:

- Dashboard: [http://localhost:5177](http://localhost:5177) in dev
- Node build: [http://localhost:3000](http://localhost:3000) after `pnpm start`

## Dashboard

The main route `/` shows:

- Total Volume all-time and today
- Session PNL and fees
- Live SUI price
- Active cycle status and hold progress
- Runtime logs
- Recent cycle history
- `Stop & Clean` control
- `Settings` control for the DB-backed bot configuration

## API endpoints

- `GET /api/bot/status`
- `GET /api/bot/stream`
- `POST /api/bot/control`

Control payloads:

```json
{ "action": "start" }
```

```json
{ "action": "stop-clean" }
```

## Runtime notes

- Maker orders are repriced if they remain open longer than `maker_reprice_seconds`.
- Size is randomized by `random_size_bps` around `notional_size_usd`.
- Delay is randomized between `min_order_delay_ms` and `max_order_delay_ms`.
- Fill waiting, pricing, order submission, and cleanup all use retry logic.
- SSE reconnect is handled by the browser automatically.

## Verification

Typecheck:

```bash
pnpm check
```

Build:

```bash
pnpm build
```

## Current limitations

- Trading fees are tracked from bot-owned execution events. Pure maker fills from external taker matches are effectively treated as near-zero fees.
- Pyth price objects are currently consumed from the active shared objects already on-chain. On very low activity pools you may want to extend the runtime to push fresh Pyth updates inside the bot transaction.
- This is intended for a long-lived Node process. It is not designed for serverless deployment.

## Project layout

```text
src/
  lib/
    server/bot/
      config.ts
      db.ts
      deepbook.ts
      runtime.ts
    types/bot.ts
  routes/
    (app)/
      +page.server.ts
      +page.svelte
    api/bot/
      control/+server.ts
      settings/+server.ts
      status/+server.ts
      stream/+server.ts
config.example.yaml
```
