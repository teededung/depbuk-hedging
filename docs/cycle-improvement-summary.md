# Cycle Improvement Summary

Use this file as the current source of truth before changing cycle execution again.

For cleanup-specific behavior, also read:

- [cleanup-runbook.md](/Users/rongmauhong/Documents/Repo/sui/sui-hedging/docs/cleanup-runbook.md)

## Current baseline

The bot is no longer symmetric by wallet asset:

- `Account A (Long)` is funded in `SUI`
- `Account B (Short)` is funded in `USDC`

This is intentional and now matches the current default execution model more closely to
DeepTrade.

## Funding and preflight

### Per-account target assets

- `accountA` preflight, auto-topup, and manual wallet prep target `SUI`
- `accountB` preflight, auto-topup, and manual wallet prep target `USDC`
- long opens should not pre-swap into `USDC` when wallet `SUI` is already sufficient

### Auto-reduce sizing

`Notional USD` is still the configured base size, but the runtime can now reduce the
effective size only when funding is short:

- `notional_auto_reduce_floor_pct` sets the minimum allowed size as a percentage of base notional
- if funding is sufficient, the bot uses the full configured size
- if funding is short but still above floor, the bot reduces the cycle size
- if funding is below floor, preflight blocks the start

Important:

- cycle execution must use the computed effective notional, not the raw configured notional
- once auto-reduced, positive jitter must not push notional back above the affordable ceiling

### Between-cycle funding maintenance

When `auto_swap_enabled = true`, the runtime now performs funding maintenance between
successful cycles:

- refresh balances after a completed cycle
- compute the same funding target used by wallet prep
- if an account is short of its target asset, swap only the residual shortfall
- skip when the bot is stopping, cleaning, or has reached `max_cycles`

This is now the primary mechanism for keeping multi-cycle funding stable.
Manual `Auto-Balance` remains useful as a wallet-preparation tool before starting or while idle.

## Open execution

### Long open

Default long open is now DeepTrade-style in spirit:

- deposit `SUI` collateral from wallet on `accountA`
- optionally include tiny existing quote if already available
- `borrow_quote`
- derive market-buy quantity from quote budget with `get_base_quantity_out`
- update current price immediately before submit

This is why `accountA` no longer needs repeated `SUI -> USDC` swaps just to open long.

### Short open

Short open remains quote-collateralized:

- deposit quote collateral on `accountB`
- borrow the full base quantity
- sell the full borrowed base quantity

This means `accountB` may still need `SUI -> USDC` topups when wallet `USDC` falls below
its required short-side collateral target.

### Open robustness

Current open-side protections that should be preserved:

- order-id reconciliation from `txDigest` and open-order diffs
- boundary-price retry after partial-fill open residuals
- auto-topup swap split from order submission
- retryable market-open warnings may happen when funding is near the execution boundary

## Close and cleanup

### Close behavior

Close retries must reload live manager state after partial fills:

- `LONG` residual tracks live `baseAsset`
- `SHORT` residual tracks live `baseDebt`

Dedicated market close PTBs are now the baseline:

- long close: market sell -> `repay_quote(None)` -> calculate -> withdraw
- short close: market buy -> `repay_base(None)` -> calculate -> withdraw

Both cycle-close and cleanup-close should continue to share these same service methods.

### Cleanup behavior

Cleanup is strategy-based and capped:

- classify manager state first
- run one primary strategy
- verify
- optionally run one secondary strategy
- hard cap: 1-3 PTBs per manager

Cleanup should not return to the old “run every fallback in sequence” behavior.
Reduce-only limit remains only for the residual states where it is actually the right tool.

### Failed-cycle cleanup

If a cycle fails after creating on-chain state, the runtime must clean before continuing
or stopping:

- no immediate retry into the next cycle with dirty managers
- if post-failure cleanup fails, the bot should stop instead of creating more broken cycles
- cycle rows should only be created after funding checks pass, so pre-open funding failures
  do not create empty history cards

## Logs, stats, and UI

### Logs

- runtime logs shown in the UI may use short display text for known noisy aborts
- raw error strings must stay intact in DB/meta for debugging
- the newest retryable warning row may show a temporary `retrying` indicator
- cycle-start logs may style the account label, but log text should remain plain data

### Feed stability

- snapshot log refresh should not overwrite newer appended logs with stale batches
- recent cycle/cleanup groups should render as whole groups, not clipped global tails

### Fill details and toasts

- cycle history and runtime logs record actual fill price, fill quantity, `txDigest`, and `orderId`
- fill-confirming live logs can emit success toasts with a SuiScan link

### Costs and stats

- trade fees come from on-chain fill events
- gas stats should include real gas from order submits and cycle-generated helper txs such as:
  - auto-topup swaps
  - withdraw-settled calls

## What still counts as expected noise

These alone are not proof of a strategy regression:

- transient `429`
- retryable market-open boundary failures
- `assert_execution ... 5` followed by successful retry
- cleanup warnings before final verification succeeds
- object-version noise during cleanup

Final truth remains:

1. on-chain manager state
2. preflight `state` and `blockingReason`
3. cycle history plus runtime logs

## What to inspect first when something breaks

### If long/short funding looks wrong

Inspect:

- preflight `requiredAsset` / `requiredAmount`
- funding maintenance logs
- the open submit input shape for the affected account

### If close fails again

Inspect:

- `settleFilledBalances()`
- `loadCloseState()`
- the dedicated close PTB path for the affected side
- final manager state after any retry/cancel

### If cleanup looks noisy

Inspect:

- cleanup strategy selection logs
- cleanup secondary-strategy logs
- final manager state after verification
