# Cleanup Runbook

This note is the current reference for how `Clean` is supposed to behave in the bot.

Use it when:

- preflight says `Cleanup required`
- a cycle completed but the next start is still blocked
- runtime logs mention `compact cleanup`, `repay and withdraw`, or `recoverable intermediate errors`

## Goal

`Clean` should leave each managed account flat for the configured pool:

- no open orders
- no conditional orders
- no meaningful asset left in margin
- no meaningful debt left in margin

The important outcome is the final manager state, not whether every intermediate PTB succeeded on the first try.

## Cleanup strategy

`Clean` is intentionally hybrid. It should not use one primitive for every manager state.

The current strategy is:

1. Cancel conditional orders.
2. Cancel open orders.
3. Withdraw settled amounts.
4. Inspect the margin manager.
5. If the manager still carries real debt and the opposite asset exists inside margin:
   - `LONG` debt state: use a dedicated market sell + repay quote + withdraw PTB.
   - `SHORT` debt state: use a dedicated market buy + repay base + withdraw PTB.
6. If residual exposure remains above pool minimum size, use a reduce-only limit order.
7. If residual debt remains below pool minimum size, skip the limit-order path and go straight to `repayAndWithdrawAll()`.
8. Run the compact cleanup withdraw PTB only when the manager is no longer in the "small residual debt" state that makes raw withdraw fail.
9. Re-inspect the manager and treat final flat state as success, even if earlier retry logs recorded recoverable errors.

## Why cleanup is not "force market close everything"

Generic `force market close` is not the right default for this bot.

Reasons:

- DeepBook manager state is debt-sensitive. A raw taker close can still fail if the PTB does not repay and withdraw in the right order.
- Reduce-only market cleanup has already proven less reliable than reduce-only limit in some real manager states.
- Market closes must respect lot-size and min-size quantization. If the target is chosen naively, the transaction can leave a residual debt behind.
- Cleanup's job is to flatten the manager, not to maximize execution speed at any cost.

The safe default is:

- debt-coupled state -> dedicated market repay PTB
- residual position above min size -> reduce-only limit
- dust residual below min size -> wallet-assisted repay/withdraw fallback

## Current implementation details

### Long-side cleanup

If the manager has quote debt but still holds base asset, cleanup does not try to sell the full base exposure blindly.

It instead:

- computes `netQuoteDebt = max(quoteDebt - quoteAsset, 0)`
- sells only enough base to cover that debt
- repays quote inside the same PTB
- withdraws leftover assets

This avoids the old `withdraw_with_proof ... 3` style failures caused by selling the wrong quantity.

### Short-side cleanup

If the manager has base debt but still holds quote asset, cleanup does not assume the raw residual debt quantity is executable as-is.

It now:

- rounds the target up to the next executable lot
- respects the pool minimum size when estimating market-buy coverage
- repays base and withdraws leftovers in the same PTB

This matters because a target like `30.780752756` can otherwise become an actual market fill of `30.7`, leaving a residual debt and blocking the next cycle.

### Short dust below pool minimum size

If short residual debt remains but is below pool `minSize`, cleanup must not keep trying order-based close paths first.

Why:

- a reduce-only limit buy below `minSize` is not executable
- a compact withdraw PTB will still fail while debt remains

Correct behavior:

- log that the residual short exposure is below pool minimum size
- skip compact withdraw at that point
- run `repayAndWithdrawAll()` so the wallet can repay the tiny remaining debt
- verify the manager again after that fallback

## Compact cleanup PTB

The compact cleanup withdraw PTB is still useful, but only in the right state.

Its job is to do a light-weight:

- cancel conditional orders
- withdraw settled amounts
- cancel open orders
- calculate assets
- withdraw base
- withdraw quote

This is a good path when the manager is already effectively debt-free.

It is not the right first choice when residual debt is still present and known to be below orderable size.

## Interpreting cleanup logs

Healthy cleanup may still contain warnings.

Examples:

- `run compact cleanup withdraw PTB failed`
- `status code: 429`
- object version warnings

These do not automatically mean cleanup failed.

Final truth is:

- preflight `state`
- preflight `blockingReason`
- direct on-chain manager state

If the manager is flat after the run, intermediate errors are recoverable noise, not a functional failure.

## Concrete lesson from cycles 34 and 35

The observed failure pattern was:

1. a short market close used a quantity that was effectively rounded down by execution
2. the cycle looked completed, but a small short debt remained
3. the next preflight blocked on `Cleanup required`
4. cleanup skipped the reduce-only limit order because the residual was below `minSize`
5. cleanup then tried compact withdraw too early
6. compact withdraw failed with `margin_manager::withdraw ... 8`

The fixes for that pattern are now:

- short market-buy coverage targets are rounded to executable lot/min-size boundaries
- short dust cleanup goes to `repayAndWithdrawAll()` before compact withdraw

## Operational guidance

Before pressing `Clean`:

- trust the current preflight modal, not stale UI memory
- if you just changed runtime code locally, restart the dev server first because the bot runtime is a long-lived singleton

After pressing `Clean`:

- look for the newest `cleanupRunId`
- read manager-specific logs in order
- verify whether the manager ended flat before reacting to intermediate warnings

## Dust thresholds

Current operational dust thresholds:

- base debt dust: `0.00001 SUI`
- quote debt dust: `0.01 USDC`

These are bot thresholds, not protocol constants.

## Files to inspect when cleanup breaks

- [/Users/rongmauhong/Documents/Repo/sui/sui-hedging/src/lib/server/bot/runtime-cleanup-executor.ts](/Users/rongmauhong/Documents/Repo/sui/sui-hedging/src/lib/server/bot/runtime-cleanup-executor.ts)
- [/Users/rongmauhong/Documents/Repo/sui/sui-hedging/src/lib/server/bot/deepbook.ts](/Users/rongmauhong/Documents/Repo/sui/sui-hedging/src/lib/server/bot/deepbook.ts)
- [/Users/rongmauhong/Documents/Repo/sui/sui-hedging/src/lib/server/bot/runtime-snapshot.ts](/Users/rongmauhong/Documents/Repo/sui/sui-hedging/src/lib/server/bot/runtime-snapshot.ts)

## Related docs

- [/Users/rongmauhong/Documents/Repo/sui/sui-hedging/docs/cycle-improvement-summary.md](/Users/rongmauhong/Documents/Repo/sui/sui-hedging/docs/cycle-improvement-summary.md)
