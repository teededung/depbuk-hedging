import { describe, expect, it, vi } from 'vitest';

import type { DeepBookInternalContext } from './deepbook-context.js';
import type { ManagedAccount } from './deepbook.js';
import { transferSuiBetweenAccounts, transferUsdcBetweenAccounts } from './deepbook-execution.js';

function decodeAddressInput(txData: any, inputIndex: number): string {
	return Buffer.from(txData.inputs[inputIndex].Pure.bytes, 'base64').toString('hex');
}

function decodeU64Input(txData: any, inputIndex: number): bigint {
	return Buffer.from(txData.inputs[inputIndex].Pure.bytes, 'base64').readBigUInt64LE(0);
}

function createAccounts(): { from: ManagedAccount; to: ManagedAccount } {
	return {
		from: {
			key: 'accountB',
			label: 'Account B',
			address: '0x2222222222222222222222222222222222222222222222222222222222222222',
			signer: {} as never
		},
		to: {
			key: 'accountA',
			label: 'Account A',
			address: '0x3333333333333333333333333333333333333333333333333333333333333333',
			signer: {} as never
		}
	};
}

describe('transferUsdcBetweenAccounts', () => {
	it('uses sender wallet USDC and transfers to recipient with expected coin type', async () => {
		const { from, to } = createAccounts();
		const getCoins = vi.fn().mockResolvedValue({
			data: [
				{
					coinObjectId: '0x1111111111111111111111111111111111111111111111111111111111111111',
					balance: '10000000'
				}
			],
			hasNextPage: false,
			nextCursor: null
		});
		const signAndExecute = vi.fn(
			async (_account: ManagedAccount, _tx: { getData: () => any }) => ({ digest: '0xtx1' })
		);
		const ctx = {
			quoteCoin: { type: '0xusdc::usdc::USDC', scalar: 1_000_000 },
			normalizeCoinAmount: (_coinType: string, atomicAmount: string | number | bigint) =>
				Number(atomicAmount) / 1_000_000,
			withReadRpc: async (
				_operation: string,
				fn: (client: { getCoins: typeof getCoins }, rpcUrl: string) => Promise<any>
			) => fn({ getCoins }, 'http://rpc'),
			signAndExecute
		} as unknown as DeepBookInternalContext;

		const result = await transferUsdcBetweenAccounts(ctx, {
			from,
			to,
			amount: 8.4
		});

		expect(getCoins).toHaveBeenCalledWith({
			owner: from.address,
			coinType: '0xusdc::usdc::USDC',
			cursor: undefined,
			limit: 50
		});
		expect(signAndExecute).toHaveBeenCalledTimes(1);

		const txArg = signAndExecute.mock.calls[0]?.[1];
		expect(txArg).toBeDefined();
		const txData = txArg!.getData();
		expect(txData.sender).toBe(from.address);
		const transferCommand = txData.commands.find((command: any) => command.$kind === 'TransferObjects');
		expect(transferCommand).toBeDefined();
		const recipientInputIndex = transferCommand.TransferObjects.address.Input;
		expect(decodeAddressInput(txData, recipientInputIndex)).toBe(to.address.slice(2));

		expect(result).toEqual({
			txDigest: '0xtx1',
			amount: 8.4,
			coinType: '0xusdc::usdc::USDC'
		});
	});

	it('matches requested amount using USDC atomic precision semantics', async () => {
		const { from, to } = createAccounts();
		const getCoins = vi.fn().mockResolvedValue({
			data: [
				{
					coinObjectId: '0x1111111111111111111111111111111111111111111111111111111111111111',
					balance: '2000000'
				}
			],
			hasNextPage: false,
			nextCursor: null
		});
		const signAndExecute = vi.fn(
			async (_account: ManagedAccount, _tx: { getData: () => any }) => ({ digest: '0xtx2' })
		);
		const ctx = {
			quoteCoin: { type: '0xusdc::usdc::USDC', scalar: 1_000_000 },
			normalizeCoinAmount: (_coinType: string, atomicAmount: string | number | bigint) =>
				Number(atomicAmount) / 1_000_000,
			withReadRpc: async (
				_operation: string,
				fn: (client: { getCoins: typeof getCoins }, rpcUrl: string) => Promise<any>
			) => fn({ getCoins }, 'http://rpc'),
			signAndExecute
		} as unknown as DeepBookInternalContext;

		const result = await transferUsdcBetweenAccounts(ctx, {
			from,
			to,
			amount: 1.23456789
		});
		const txArg = signAndExecute.mock.calls[0]?.[1];
		expect(txArg).toBeDefined();
		const txData = txArg!.getData();
		const splitCommand = txData.commands.find((command: any) => command.$kind === 'SplitCoins');
		expect(splitCommand).toBeDefined();
		const amountInputIndex = splitCommand.SplitCoins.amounts[0].Input;
		expect(decodeU64Input(txData, amountInputIndex)).toBe(1_234_567n);
		expect(result.amount).toBe(1.234567);
	});
});

describe('transferSuiBetweenAccounts', () => {
	it('uses sender wallet SUI and transfers requested amount', async () => {
		const { from, to } = createAccounts();
		const getCoins = vi.fn().mockResolvedValue({
			data: [
				{
					coinObjectId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					balance: '5000000000'
				}
			],
			hasNextPage: false,
			nextCursor: null
		});
		const signAndExecute = vi.fn(
			async (_account: ManagedAccount, _tx: { getData: () => any }) => ({ digest: '0xtx-sui-1' })
		);
		const ctx = {
			baseCoin: { type: '0x2::sui::SUI', scalar: 1_000_000_000 },
			quoteCoin: { type: '0xusdc::usdc::USDC', scalar: 1_000_000 },
			config: { min_gas_reserve_sui: 1 },
			normalizeCoinAmount: (_coinType: string, atomicAmount: string | number | bigint) =>
				Number(atomicAmount) / 1_000_000_000,
			withReadRpc: async (
				_operation: string,
				fn: (client: { getCoins: typeof getCoins }, rpcUrl: string) => Promise<any>
			) => fn({ getCoins }, 'http://rpc'),
			signAndExecute
		} as unknown as DeepBookInternalContext;

		const result = await transferSuiBetweenAccounts(ctx, {
			from,
			to,
			amount: 2.25
		});

		expect(getCoins).toHaveBeenCalledWith({
			owner: from.address,
			coinType: '0x2::sui::SUI',
			cursor: undefined,
			limit: 50
		});
		expect(result).toEqual({
			txDigest: '0xtx-sui-1',
			amount: 2.25,
			coinType: '0x2::sui::SUI'
		});
	});

	it('splits transfer amount from gas coin so single-coin wallets can still pay gas', async () => {
		const { from, to } = createAccounts();
		const getCoins = vi.fn().mockResolvedValue({
			data: [
				{
					coinObjectId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					balance: '5000000000'
				}
			],
			hasNextPage: false,
			nextCursor: null
		});
		const signAndExecute = vi.fn(
			async (_account: ManagedAccount, tx: { getData: () => any }) => {
				const txData = tx.getData();
				const splitCommand = txData.commands.find((command: any) => command.$kind === 'SplitCoins');
				expect(splitCommand?.SplitCoins?.coin).toEqual({ $kind: 'GasCoin', GasCoin: true });
				return { digest: '0xtx-sui-gas' };
			}
		);
		const ctx = {
			baseCoin: { type: '0x2::sui::SUI', scalar: 1_000_000_000 },
			quoteCoin: { type: '0xusdc::usdc::USDC', scalar: 1_000_000 },
			config: { min_gas_reserve_sui: 1 },
			normalizeCoinAmount: (_coinType: string, atomicAmount: string | number | bigint) =>
				Number(atomicAmount) / 1_000_000_000,
			withReadRpc: async (
				_operation: string,
				fn: (client: { getCoins: typeof getCoins }, rpcUrl: string) => Promise<any>
			) => fn({ getCoins }, 'http://rpc'),
			signAndExecute
		} as unknown as DeepBookInternalContext;

		await transferSuiBetweenAccounts(ctx, {
			from,
			to,
			amount: 2.25
		});
		expect(signAndExecute).toHaveBeenCalledTimes(1);
	});

	it('rejects when available SUI after gas reserve is not enough', async () => {
		const { from, to } = createAccounts();
		const getCoins = vi.fn().mockResolvedValue({
			data: [
				{
					coinObjectId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
					balance: '1200000000'
				}
			],
			hasNextPage: false,
			nextCursor: null
		});
		const ctx = {
			baseCoin: { type: '0x2::sui::SUI', scalar: 1_000_000_000 },
			quoteCoin: { type: '0xusdc::usdc::USDC', scalar: 1_000_000 },
			config: { min_gas_reserve_sui: 1 },
			normalizeCoinAmount: (_coinType: string, atomicAmount: string | number | bigint) =>
				Number(atomicAmount) / 1_000_000_000,
			withReadRpc: async (
				_operation: string,
				fn: (client: { getCoins: typeof getCoins }, rpcUrl: string) => Promise<any>
			) => fn({ getCoins }, 'http://rpc'),
			signAndExecute: vi.fn()
		} as unknown as DeepBookInternalContext;

		await expect(
			transferSuiBetweenAccounts(ctx, {
				from,
				to,
				amount: 0.5
			})
		).rejects.toThrow('after gas reserve');
	});
});
