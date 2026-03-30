# Workspace Notes

Read this file at the start of every new session before making assumptions about the app.

## Local app

- The dashboard runs at `http://localhost:5187/`.
- If you need to verify UI changes, prefer this URL first instead of the default SvelteKit port.

## Project context

- This repo is a SvelteKit 2 + Svelte 5 DeepBook hedging bot dashboard and runtime.
- The UI is a dark trading dashboard. Preserve that visual direction when editing.
- The bot runtime is Node-based and persists data in Postgres.
- Bot settings now live in Postgres (`bot_settings`) and are edited from the in-app Settings modal.
- `config.yaml` is legacy reference only and should not be treated as the runtime source of truth.

## Useful reminders

- Check `src/routes/(app)/+page.svelte` first for dashboard layout and styling changes.
- Check `src/lib/server/bot/runtime.ts` first for lifecycle, snapshot, and control flow changes.
- Check `src/lib/server/bot/deepbook.ts` first for market data and DeepBook execution logic.
- For form controls and labels, follow [docs/input-label-patterns.md](/Users/rongmauhong/Documents/Repo/sui/sui-hedging/docs/input-label-patterns.md).
- Avoid adding new custom CSS classes when Tailwind or DaisyUI utility classes can handle the UI directly.
- Only add custom CSS when Tailwind/DaisyUI cannot express the needed behavior or visual treatment cleanly.
- The SUI price card is expected to show a live price even when trade config is invalid; do not regress that fallback behavior.
- Keep `Stop & Clean` graceful and non-destructive to unrelated data.

## Recent verified behavior

- Before changing cycle execution logic again, read [docs/cycle-improvement-summary.md](/Users/rongmauhong/Documents/Repo/sui/sui-hedging/docs/cycle-improvement-summary.md) first. It consolidates the currently relevant execution, retry, top-up, and cleanup improvements.
- A full cycle has now been verified on mainnet: both open legs filled and both close legs completed after the hold window.
- Close logic depends on settling balances after open fills. If cycle close breaks, inspect `#settleFilledBalances()` and `#loadCloseState()` in `runtime.ts` first.
- The default funding model is now asset-specific:
  - `Account A (Long)` targets `SUI`
  - `Account B (Short)` targets `USDC`
- Manual `Auto-Balance` is now a wallet-preparation tool. Ongoing multi-cycle stability should come from post-cycle funding maintenance in the runtime when `auto_swap_enabled = true`.
- Failed cycles that already created on-chain state should auto-clean before retrying or stopping. Do not reintroduce immediate retry-on-dirty-state behavior.
- Cycle rows should only be created after funding checks pass. Avoid bringing back empty failed cycle cards caused by pre-open funding failures.
- `Cycle History` and runtime logs now record actual fill details for both Account A and Account B:
  - fill price
  - fill quantity
  - order id / tx digest in log detail
- UI log rows may shorten known noisy errors for readability, but raw error strings in DB/meta must remain intact for debugging.
- Runtime feed was flattened to reduce card nesting. Keep that direction; avoid re-introducing deeply nested card-inside-card log layouts.

## Cleanup notes

- `Clean` may emit intermediate `429` and object-version warnings even when on-chain cleanup eventually succeeds.
- Final truth is:
  - preflight `state`
  - `blockingReason`
  - direct on-chain manager state
- If `Clean` logs an error but both managers are flat on-chain, treat it as a cleanup false-negative first and inspect the final verification path before changing order logic.
- `bot_manager_cache` intentionally survives `Clean` and is used to speed later cleanup/preflight runs.

## Validation

- Default validation after finishing a task: run `pnpm check`.
- Do not run `pnpm build` unless the user explicitly asks for it.
- When validating runtime behavior locally, make sure Postgres is reachable.
- Add tests selectively. Prioritize tests that protect important behavior, money paths, public contracts, risky orchestration, or real regressions.
- Avoid generating large numbers of low-value tests that mostly mirror implementation details, trivial clamping/defaults, or message text unless they guard a concrete failure mode.
