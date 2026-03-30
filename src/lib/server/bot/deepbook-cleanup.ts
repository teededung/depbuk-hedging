/**
 * Cleanup service operations: cancel, withdraw, compact cleanup, repay-and-withdraw-all.
 */

import {
	Transaction,
	type TransactionArgument,
	type TransactionObjectArgument
} from '@mysten/sui/transactions';

import type { DeepBookInternalContext } from './deepbook-context.js';
import type { ManagedAccount } from './deepbook.js';
import { floorToAtomicUnits } from './deepbook-shared.js';
import { extractGasUsedSui } from './deepbook-margin-state.js';
import { getMarginManagerState } from './deepbook-margin-state.js';

function buildManagerWithdrawMoveCall(
	tx: Transaction,
	ctx: DeepBookInternalContext,
	account: ManagedAccount,
	assetAmount: TransactionArgument,
	withdrawnType: string
): TransactionObjectArgument {
	const baseMarginPool = ctx.marginPools[ctx.pool.baseCoin as string];
	const quoteMarginPool = ctx.marginPools[ctx.pool.quoteCoin as string];
	return tx.moveCall({
		target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::margin_manager::withdraw`,
		arguments: [
			tx.object(account.marginManagerId!),
			tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
			tx.object(baseMarginPool.address),
			tx.object(quoteMarginPool.address),
			tx.object(ctx.baseCoin.priceInfoObjectId!),
			tx.object(ctx.quoteCoin.priceInfoObjectId!),
			tx.object(ctx.pool.address),
			assetAmount,
			tx.object.clock()
		],
		typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type, withdrawnType]
	});
}

function transferWithdrawnCoins(
	tx: Transaction,
	account: ManagedAccount,
	withdrawnCoins: TransactionObjectArgument[]
): void {
	if (withdrawnCoins.length > 0) {
		tx.transferObjects(withdrawnCoins, tx.pure.address(account.address));
	}
}

export async function cancelAllOrders(
	ctx: DeepBookInternalContext,
	account: ManagedAccount
): Promise<void> {
	const { poolProxy } = ctx.sdk({ [account.key]: account });
	const tx = new Transaction();
	tx.setSender(account.address);
	poolProxy.cancelAllOrders(account.key)(tx);
	await ctx.signAndExecute(account, tx);
}

export async function withdrawSettled(
	ctx: DeepBookInternalContext,
	account: ManagedAccount
): Promise<{ txDigest: string; gasUsedSui: number }> {
	const { poolProxy } = ctx.sdk({ [account.key]: account });
	const tx = new Transaction();
	tx.setSender(account.address);
	poolProxy.withdrawSettledAmounts(account.key)(tx);
	const response = await ctx.signAndExecute(account, tx, {
		options: { showEffects: true, showEvents: true, showBalanceChanges: true }
	});
	return {
		txDigest: response.digest,
		gasUsedSui: extractGasUsedSui(response, ctx.coins.SUI.scalar)
	};
}

export async function repayFromManagerAndWithdraw(
	ctx: DeepBookInternalContext,
	account: ManagedAccount
): Promise<{ txDigest: string; gasUsedSui: number }> {
	if (!account.marginManagerId) {
		throw new Error(`Missing margin manager id for ${account.label}`);
	}
	const stateBefore = await getMarginManagerState(ctx, account);
	const baseDebtAtomic = floorToAtomicUnits(stateBefore.baseDebt, ctx.baseCoin.scalar);
	const quoteDebtAtomic = floorToAtomicUnits(stateBefore.quoteDebt, ctx.quoteCoin.scalar);
	const baseAssetAtomic = floorToAtomicUnits(stateBefore.baseAsset, ctx.baseCoin.scalar);
	const quoteAssetAtomic = floorToAtomicUnits(stateBefore.quoteAsset, ctx.quoteCoin.scalar);
	const hasBaseDebt = floorToAtomicUnits(stateBefore.baseDebt, ctx.baseCoin.scalar) > 0n;
	const hasQuoteDebt = floorToAtomicUnits(stateBefore.quoteDebt, ctx.quoteCoin.scalar) > 0n;
	const shouldWithdrawBaseAfterRepay = baseAssetAtomic > baseDebtAtomic;
	const shouldWithdrawQuoteAfterRepay = quoteAssetAtomic > quoteDebtAtomic;

	const { marginManager, poolProxy } = ctx.sdk({ [account.key]: account });
	const baseMarginPool = ctx.marginPools[ctx.pool.baseCoin as string];
	const quoteMarginPool = ctx.marginPools[ctx.pool.quoteCoin as string];
	const tx = new Transaction();
	tx.setSender(account.address);

	poolProxy.withdrawSettledAmounts(account.key)(tx);
	if (hasBaseDebt) {
		tx.moveCall({
			target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::margin_manager::repay_base`,
			arguments: [
				tx.object(account.marginManagerId),
				tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
				tx.object(baseMarginPool.address),
				tx.pure.option('u64', null),
				tx.object.clock()
			],
			typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type]
		});
	}
	if (hasQuoteDebt) {
		tx.moveCall({
			target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::margin_manager::repay_quote`,
			arguments: [
				tx.object(account.marginManagerId),
				tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
				tx.object(quoteMarginPool.address),
				tx.pure.option('u64', null),
				tx.object.clock()
			],
			typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type]
		});
	}

	const [baseAssetAmount, quoteAssetAmount] = marginManager.calculateAssets(
		ctx.config.pool_key,
		account.marginManagerId
	)(tx) as unknown as [TransactionArgument, TransactionArgument];
	const withdrawnCoins: TransactionObjectArgument[] = [];
	if (shouldWithdrawBaseAfterRepay) {
		withdrawnCoins.push(
			buildManagerWithdrawMoveCall(tx, ctx, account, baseAssetAmount, ctx.baseCoin.type)
		);
	}
	if (shouldWithdrawQuoteAfterRepay) {
		withdrawnCoins.push(
			buildManagerWithdrawMoveCall(tx, ctx, account, quoteAssetAmount, ctx.quoteCoin.type)
		);
	}

	transferWithdrawnCoins(tx, account, withdrawnCoins);
	const response = await ctx.signAndExecute(account, tx, {
		options: { showEffects: true, showEvents: true, showBalanceChanges: true }
	});
	return {
		txDigest: response.digest,
		gasUsedSui: extractGasUsedSui(response, ctx.coins.SUI.scalar)
	};
}

export async function cancelAllConditionalOrders(
	ctx: DeepBookInternalContext,
	account: ManagedAccount
): Promise<void> {
	const { marginTPSL } = ctx.sdk({ [account.key]: account });
	const tx = new Transaction();
	tx.setSender(account.address);
	marginTPSL.cancelAllConditionalOrders(account.key)(tx);
	await ctx.signAndExecute(account, tx);
}

export async function compactCleanupWithdraw(
	ctx: DeepBookInternalContext,
	account: ManagedAccount
): Promise<void> {
	if (!account.marginManagerId) {
		return;
	}

	const currentState = await getMarginManagerState(ctx, account);
	const shouldWithdrawBase = floorToAtomicUnits(currentState.baseAsset, ctx.baseCoin.scalar) > 0n;
	const shouldWithdrawQuote =
		floorToAtomicUnits(currentState.quoteAsset, ctx.quoteCoin.scalar) > 0n;

	const { marginManager, marginTPSL, poolProxy } = ctx.sdk({ [account.key]: account });

	const tx = new Transaction();
	tx.setSender(account.address);
	marginTPSL.cancelAllConditionalOrders(account.key)(tx);
	poolProxy.withdrawSettledAmounts(account.key)(tx);
	poolProxy.cancelAllOrders(account.key)(tx);

	const [baseAssetAmount, quoteAssetAmount] = marginManager.calculateAssets(
		ctx.config.pool_key,
		account.marginManagerId
	)(tx) as unknown as [TransactionArgument, TransactionArgument];

	const withdrawnCoins: TransactionObjectArgument[] = [];
	if (shouldWithdrawBase) {
		withdrawnCoins.push(
			buildManagerWithdrawMoveCall(tx, ctx, account, baseAssetAmount, ctx.baseCoin.type)
		);
	}
	if (shouldWithdrawQuote) {
		withdrawnCoins.push(
			buildManagerWithdrawMoveCall(tx, ctx, account, quoteAssetAmount, ctx.quoteCoin.type)
		);
	}

	transferWithdrawnCoins(tx, account, withdrawnCoins);
	await ctx.signAndExecute(account, tx);
}

async function withdrawManagerAsset(
	ctx: DeepBookInternalContext,
	account: ManagedAccount,
	asset: 'base' | 'quote',
	amount: number
): Promise<void> {
	if (!account.marginManagerId || amount <= 0) {
		return;
	}

	const coin = asset === 'base' ? ctx.baseCoin : ctx.quoteCoin;
	const withdrawAmount = Math.floor(amount * coin.scalar);
	if (withdrawAmount <= 0) {
		return;
	}

	const baseMarginPool = ctx.marginPools[ctx.pool.baseCoin as string];
	const quoteMarginPool = ctx.marginPools[ctx.pool.quoteCoin as string];
	const tx = new Transaction();
	tx.setSender(account.address);
	const withdrawnCoin = tx.moveCall({
		target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::margin_manager::withdraw`,
		arguments: [
			tx.object(account.marginManagerId),
			tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
			tx.object(baseMarginPool.address),
			tx.object(quoteMarginPool.address),
			tx.object(ctx.baseCoin.priceInfoObjectId!),
			tx.object(ctx.quoteCoin.priceInfoObjectId!),
			tx.object(ctx.pool.address),
			tx.pure.u64(withdrawAmount),
			tx.object.clock()
		],
		typeArguments: [
			ctx.baseCoin.type,
			ctx.quoteCoin.type,
			asset === 'base' ? ctx.baseCoin.type : ctx.quoteCoin.type
		]
	});
	tx.transferObjects([withdrawnCoin], tx.pure.address(account.address));

	await ctx.signAndExecute(account, tx);
}

async function depositAndRepayResidualDebt(
	ctx: DeepBookInternalContext,
	account: ManagedAccount,
	asset: 'base' | 'quote',
	amount: number
): Promise<number> {
	if (amount <= 0) {
		return 0;
	}

	const exactAmountAtomic = floorToAtomicUnits(
		Math.min(amount, await walletAssetAvailableForRepay(ctx, account, asset)),
		asset === 'base' ? ctx.baseCoin.scalar : ctx.quoteCoin.scalar
	);
	if (exactAmountAtomic <= 0n) {
		return 0;
	}

	const exactAmount =
		asset === 'base'
			? Number(exactAmountAtomic) / ctx.baseCoin.scalar
			: Number(exactAmountAtomic) / ctx.quoteCoin.scalar;
	const { marginManager } = ctx.sdk({ [account.key]: account });
	const tx = new Transaction();
	tx.setSender(account.address);

	if (asset === 'base') {
		marginManager.depositBase({ managerKey: account.key, amount: exactAmount })(tx);
		marginManager.repayBase(account.key, exactAmount)(tx);
	} else {
		marginManager.depositQuote({ managerKey: account.key, amount: exactAmount })(tx);
		marginManager.repayQuote(account.key, exactAmount)(tx);
	}

	await ctx.signAndExecute(account, tx);
	return exactAmount;
}

async function walletCoinBalance(
	ctx: DeepBookInternalContext,
	account: ManagedAccount,
	coinType: string
): Promise<number> {
	const balance = await ctx.withReadRpc(`get balance for ${account.label}`, (client) =>
		client.getBalance({ owner: account.address, coinType })
	);
	return ctx.normalizeCoinAmount(coinType, balance.totalBalance);
}

async function walletAssetAvailableForRepay(
	ctx: DeepBookInternalContext,
	account: ManagedAccount,
	asset: 'base' | 'quote'
): Promise<number> {
	if (asset === 'base') {
		const balance = await walletCoinBalance(ctx, account, ctx.baseCoin.type);
		return Math.max(balance - ctx.config.min_gas_reserve_sui, 0);
	}

	return walletCoinBalance(ctx, account, ctx.quoteCoin.type);
}

async function ensureWalletAssetForResidualRepay(
	ctx: DeepBookInternalContext,
	account: ManagedAccount,
	asset: 'base' | 'quote',
	amount: number,
	referencePrice: number
): Promise<void> {
	if (amount <= 0) {
		return;
	}

	const available = await walletAssetAvailableForRepay(ctx, account, asset);
	if (available + 1e-9 >= amount) {
		return;
	}

	if (!ctx.config.auto_swap_enabled) {
		const symbol = asset === 'base' ? 'SUI' : 'USDC';
		throw new Error(`Not enough ${symbol} in wallet to repay residual debt`);
	}

	const { swapExactInWithAggregator } = await import('./deepbook-execution.js');
	const effectivePrice = Math.max(referencePrice, 0.000001);
	const swapBuffer =
		1 + ctx.config.auto_swap_buffer_bps / 10000 + Math.max(ctx.config.slippage_tolerance, 0);
	const deficit = amount - available;

	if (asset === 'quote') {
		const availableSui = await walletAssetAvailableForRepay(ctx, account, 'base');
		const requiredSui = (deficit / effectivePrice) * swapBuffer;
		if (requiredSui > availableSui + 1e-9) {
			throw new Error(
				`Not enough SUI in wallet to swap for ${deficit.toFixed(6)} USDC residual debt`
			);
		}
		await swapExactInWithAggregator(ctx, {
			account,
			coinTypeIn: ctx.baseCoin.type,
			coinTypeOut: ctx.quoteCoin.type,
			amountIn: requiredSui,
			useGasCoin: true
		});
		return;
	}

	const availableUsdc = await walletAssetAvailableForRepay(ctx, account, 'quote');
	const requiredUsdc = deficit * effectivePrice * swapBuffer;
	if (requiredUsdc > availableUsdc + 1e-9) {
		throw new Error(
			`Not enough USDC in wallet to swap for ${deficit.toFixed(9)} SUI residual debt`
		);
	}
	await swapExactInWithAggregator(ctx, {
		account,
		coinTypeIn: ctx.quoteCoin.type,
		coinTypeOut: ctx.baseCoin.type,
		amountIn: requiredUsdc
	});
}

export async function repayAndWithdrawAll(
	ctx: DeepBookInternalContext,
	account: ManagedAccount
): Promise<void> {
	const stateBefore = await getMarginManagerState(ctx, account);
	await withdrawSettled(ctx, account).catch(() => {});

	const baseRepayAtomic = floorToAtomicUnits(
		Math.min(stateBefore.baseDebt, stateBefore.baseAsset),
		ctx.baseCoin.scalar
	);
	const quoteRepayAtomic = floorToAtomicUnits(
		Math.min(stateBefore.quoteDebt, stateBefore.quoteAsset),
		ctx.quoteCoin.scalar
	);

	if (baseRepayAtomic > 0n || quoteRepayAtomic > 0n) {
		const baseMarginPool = ctx.marginPools[ctx.pool.baseCoin as string];
		const quoteMarginPool = ctx.marginPools[ctx.pool.quoteCoin as string];
		const tx = new Transaction();
		tx.setSender(account.address);

		if (baseRepayAtomic > 0n) {
			tx.moveCall({
				target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::margin_manager::repay_base`,
				arguments: [
					tx.object(account.marginManagerId!),
					tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
					tx.object(baseMarginPool.address),
					tx.pure.option('u64', baseRepayAtomic),
					tx.object.clock()
				],
				typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type]
			});
		}
		if (quoteRepayAtomic > 0n) {
			tx.moveCall({
				target: `${ctx.packageIds.MARGIN_PACKAGE_ID}::margin_manager::repay_quote`,
				arguments: [
					tx.object(account.marginManagerId!),
					tx.object(ctx.packageIds.MARGIN_REGISTRY_ID),
					tx.object(quoteMarginPool.address),
					tx.pure.option('u64', quoteRepayAtomic),
					tx.object.clock()
				],
				typeArguments: [ctx.baseCoin.type, ctx.quoteCoin.type]
			});
		}

		await ctx.signAndExecute(account, tx);
	}

	let stateAfterRepay = await getMarginManagerState(ctx, account);
	for (const asset of ['base', 'quote'] as const) {
		const scalar = asset === 'base' ? ctx.baseCoin.scalar : ctx.quoteCoin.scalar;
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			const residualDebt = asset === 'base' ? stateAfterRepay.baseDebt : stateAfterRepay.quoteDebt;
			if (floorToAtomicUnits(residualDebt, scalar) <= 0n) {
				break;
			}

			await ensureWalletAssetForResidualRepay(
				ctx,
				account,
				asset,
				residualDebt,
				stateAfterRepay.currentPrice
			);
			const repaidAmount = await depositAndRepayResidualDebt(ctx, account, asset, residualDebt);
			if (repaidAmount <= 0) {
				break;
			}
			stateAfterRepay = await getMarginManagerState(ctx, account);
		}
	}

	if (
		floorToAtomicUnits(stateAfterRepay.baseDebt, ctx.baseCoin.scalar) > 0n ||
		floorToAtomicUnits(stateAfterRepay.quoteDebt, ctx.quoteCoin.scalar) > 0n
	) {
		throw new Error(
			`Residual debt remains after repay: ${stateAfterRepay.baseDebt.toFixed(9)} SUI debt, ${stateAfterRepay.quoteDebt.toFixed(6)} USDC debt`
		);
	}

	if (stateAfterRepay.baseAsset > 0) {
		await withdrawManagerAsset(ctx, account, 'base', stateAfterRepay.baseAsset);
	}
	if (stateAfterRepay.quoteAsset > 0) {
		await withdrawManagerAsset(ctx, account, 'quote', stateAfterRepay.quoteAsset);
	}
}
