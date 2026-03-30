import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@mysten/sui/transactions';

import type { DeepBookInternalContext } from './deepbook-context.js';
import type { ManagedAccount } from './deepbook.js';
import { compactCleanupWithdraw, repayFromManagerAndWithdraw } from './deepbook-cleanup.js';
import { getMarginManagerState } from './deepbook-margin-state.js';

vi.mock('./deepbook-margin-state.js', () => ({
	extractGasUsedSui: vi.fn().mockReturnValue(0),
	getMarginManagerState: vi.fn()
}));

function objectId(fill: string): string {
	return `0x${fill.repeat(64)}`;
}

function createContext(signAndExecute: (account: ManagedAccount, tx: Transaction) => Promise<any>) {
	const marginManager = {
		calculateAssets: vi.fn((_poolKey: string, _managerId: string) => (tx: Transaction) => [
			tx.pure.u64(1),
			tx.pure.u64(1)
		])
	};
	const marginTPSL = {
		cancelAllConditionalOrders: vi.fn(() => (_tx: Transaction) => {})
	};
	const poolProxy = {
		withdrawSettledAmounts: vi.fn(() => (_tx: Transaction) => {}),
		cancelAllOrders: vi.fn(() => (_tx: Transaction) => {})
	};

	return {
		config: { pool_key: 'SUI_USDC' },
		packageIds: {
			MARGIN_PACKAGE_ID: objectId('a'),
			MARGIN_REGISTRY_ID: objectId('b')
		},
		marginPools: {
			SUI: { address: objectId('c') },
			USDC: { address: objectId('d') }
		},
		pool: {
			baseCoin: 'SUI',
			quoteCoin: 'USDC',
			address: objectId('e')
		},
		baseCoin: {
			type: `${objectId('f')}::sui::SUI`,
			scalar: 1_000_000_000,
			priceInfoObjectId: objectId('1')
		},
		quoteCoin: {
			type: `${objectId('9')}::usdc::USDC`,
			scalar: 1_000_000,
			priceInfoObjectId: objectId('2')
		},
		coins: {
			SUI: { scalar: 1_000_000_000 }
		},
		sdk: vi.fn(() => ({ marginManager, marginTPSL, poolProxy })),
		signAndExecute
	} as unknown as DeepBookInternalContext;
}

function createAccount(): ManagedAccount {
	return {
		key: 'accountA',
		label: 'Account A',
		address: objectId('3'),
		marginManagerId: objectId('4'),
		signer: {} as never
	};
}

describe('repayFromManagerAndWithdraw', () => {
	it('skips repay_base when there is no base debt', async () => {
		vi.mocked(getMarginManagerState).mockResolvedValueOnce({
			managerId: objectId('4'),
			balanceManagerId: objectId('5'),
			baseAsset: 0,
			quoteAsset: 10,
			baseDebt: 0,
			quoteDebt: 5,
			riskRatio: 0,
			currentPrice: 1
		});
		const signAndExecute = vi.fn(async (_account: ManagedAccount, tx: Transaction) => {
			const commands = JSON.stringify(tx.getData().commands);
			expect(commands).not.toContain('repay_base');
			expect(commands).toContain('repay_quote');
			return { digest: '0xtx' };
		});
		const ctx = createContext(signAndExecute);

		await repayFromManagerAndWithdraw(ctx, createAccount());
		expect(signAndExecute).toHaveBeenCalledTimes(1);
	});

	it('skips repay_quote when there is no quote debt', async () => {
		vi.mocked(getMarginManagerState).mockResolvedValueOnce({
			managerId: objectId('4'),
			balanceManagerId: objectId('5'),
			baseAsset: 10,
			quoteAsset: 0,
			baseDebt: 5,
			quoteDebt: 0,
			riskRatio: 0,
			currentPrice: 1
		});
		const signAndExecute = vi.fn(async (_account: ManagedAccount, tx: Transaction) => {
			const commands = JSON.stringify(tx.getData().commands);
			expect(commands).toContain('repay_base');
			expect(commands).not.toContain('repay_quote');
			return { digest: '0xtx' };
		});
		const ctx = createContext(signAndExecute);

		await repayFromManagerAndWithdraw(ctx, createAccount());
		expect(signAndExecute).toHaveBeenCalledTimes(1);
	});

	it('handles short-close style state where base asset is fully consumed by base debt repay', async () => {
		vi.mocked(getMarginManagerState).mockResolvedValueOnce({
			managerId: objectId('4'),
			balanceManagerId: objectId('5'),
			baseAsset: 10,
			quoteAsset: 5,
			baseDebt: 10,
			quoteDebt: 0,
			riskRatio: 0,
			currentPrice: 1
		});
		const signAndExecute = vi.fn(async (_account: ManagedAccount, tx: Transaction) => {
			const commands = JSON.stringify(tx.getData().commands);
			expect(commands).toContain('repay_base');
			expect(commands).not.toContain('repay_quote');
			return { digest: '0xtx' };
		});
		const ctx = createContext(signAndExecute);

		await repayFromManagerAndWithdraw(ctx, createAccount());
		expect(signAndExecute).toHaveBeenCalledTimes(1);
	});
});

describe('compactCleanupWithdraw', () => {
	it('withdraws both manager assets and transfers them to the account', async () => {
		vi.mocked(getMarginManagerState).mockResolvedValueOnce({
			managerId: objectId('4'),
			balanceManagerId: objectId('5'),
			baseAsset: 10,
			quoteAsset: 20,
			baseDebt: 0,
			quoteDebt: 0,
			riskRatio: 0,
			currentPrice: 1
		});
		const signAndExecute = vi.fn(async (_account: ManagedAccount, tx: Transaction) => {
			const commands = tx.getData().commands as Array<Record<string, any>>;
			expect(commands).toHaveLength(3);
			expect(commands[0].MoveCall.function).toBe('withdraw');
			expect(commands[0].MoveCall.typeArguments).toEqual([
				`${objectId('f')}::sui::SUI`,
				`${objectId('9')}::usdc::USDC`,
				`${objectId('f')}::sui::SUI`
			]);
			expect(commands[1].MoveCall.function).toBe('withdraw');
			expect(commands[1].MoveCall.typeArguments).toEqual([
				`${objectId('f')}::sui::SUI`,
				`${objectId('9')}::usdc::USDC`,
				`${objectId('9')}::usdc::USDC`
			]);
			expect(commands[2].TransferObjects).toBeDefined();
			return undefined;
		});
		const ctx = createContext(signAndExecute);

		await compactCleanupWithdraw(ctx, createAccount());
		expect(signAndExecute).toHaveBeenCalledTimes(1);
	});
});
