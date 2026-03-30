import { describe, expect, it } from 'vitest';

import {
	buildAskMarketBorrowBaseCandidates,
	buildLongCloseMarketRepayPlan,
	buildShortCloseBaseRepayPlan,
	buildShortCloseMarketRepayPlan,
	computeBidQuoteBudget,
	marketBuyCoverageTargetBase,
	extractExecutionSummaryFromEvents
} from './deepbook.js';
import { extractPaidFeesSummary } from './deepbook-margin-state.js';

describe('deepbook market helpers', () => {
	it('builds progressively wider short-market borrow candidates from taker fee', () => {
		expect(
			buildAskMarketBorrowBaseCandidates({
				quantity: 31.6,
				currentBorrowBase: 31.6,
				currentBaseFunding: 31.6,
				takerFeeRate: 0.000125
			})
		).toEqual([31.6, 31.60395, 31.61185, 31.6316]);
	});

	it('does not treat deposited base collateral as immediate market-buy quote budget', () => {
		expect(
			computeBidQuoteBudget({
				referencePrice: 10.1,
				depositBase: 5,
				depositQuote: 0.2,
				borrowQuote: 50
			})
		).toBe(50.2);
	});

	it('deduplicates candidates when existing funding already covers the fee headroom', () => {
		expect(
			buildAskMarketBorrowBaseCandidates({
				quantity: 10,
				currentBorrowBase: 8,
				currentBaseFunding: 10.02,
				takerFeeRate: 0.000125
			})
		).toEqual([8]);
	});

	it('derives long-close market sell quantity from net quote debt instead of full base exposure', () => {
		expect(
			buildLongCloseMarketRepayPlan({
				targetQuoteDebt: 20.020204,
				quoteAsset: 0.065498,
				maxBaseQuantity: 32.7,
				lotSize: 0.1,
				estimatedSellQuantity: {
					quantity: 21,
					quoteOut: 19.9857
				}
			})
		).toEqual({
			netQuoteDebt: 19.954706,
			computedSellQuantity: 21.1,
			estimatedQuoteOut: 19.9857
		});
	});

	it('rounds market-buy coverage targets up to the next executable lot and pool minimum', () => {
		expect(marketBuyCoverageTargetBase(30.780752756, 0.1, 1)).toBe(30.8);
		expect(marketBuyCoverageTargetBase(0.080840296, 0.1, 1)).toBe(1);
	});

	it('(deprecated) pre-repays existing base asset before sizing a short market close', () => {
		expect(
			buildShortCloseBaseRepayPlan({
				targetBaseDebt: 31.800003572,
				baseAsset: 0.019875
			})
		).toEqual({
			preRepayBaseQuantity: 0.019875,
			remainingBaseDebtTarget: 31.780128572
		});
	});

	it('extracts actual fill quantity and price from market-order events', () => {
		expect(
			extractExecutionSummaryFromEvents(
				[
					{
						type: '0x1::order_info::OrderFilled',
						parsedJson: {
							taker_client_order_id: '123',
							base_quantity: '20950000000',
							quote_quantity: '19951544'
						}
					}
				],
				'123',
				1_000_000_000,
				1_000_000
			)
		).toEqual({
			filledQuantity: 20.95,
			filledQuoteQuantity: 19.951544,
			averageFillPrice: 0.952341002
		});
	});

	it('normalizes sell-side paid fees in base and converts them to quote-equivalent', () => {
		expect(
			extractPaidFeesSummary(
				[
					{
						type: '0xdee9::order_info::OrderInfo',
						parsedJson: {
							is_bid: false,
							fee_is_deep: false,
							paid_fees: '3950000',
							executed_quantity: '31600000000',
							cumulative_quote_quantity: '30089520'
						}
					}
				],
				1_000_000_000,
				1_000_000
			)
		).toEqual({
			amount: 0.00395,
			asset: 'base',
			quoteEquivalent: 0.00376119
		});
	});

	it('keeps buy-side paid fees in quote units', () => {
		expect(
			extractPaidFeesSummary(
				[
					{
						type: '0xdee9::order_info::OrderInfo',
						parsedJson: {
							is_bid: true,
							fee_is_deep: false,
							paid_fees: '3799',
							executed_quantity: '32000000000',
							cumulative_quote_quantity: '30396800'
						}
					}
				],
				1_000_000_000,
				1_000_000
			)
		).toEqual({
			amount: 0.003799,
			asset: 'quote',
			quoteEquivalent: 0.003799
		});
	});
});

describe('short close planning (iteration 5 — repay-all)', () => {
	it('targets full baseDebt for market buy, not baseDebt - baseAsset', () => {
		const plan = buildShortCloseMarketRepayPlan({
			targetBaseDebt: 32,
			baseAsset: 0.02,
			quoteAsset: 31.5,
			maxQuoteQuantity: 31.5,
			estimatedBuyQuantity: { quantity: 32, quoteIn: 30.4 }
		});

		expect(plan).toEqual({
			targetBaseDebt: 32,
			computedQuoteBudget: 30.4,
			computedBuyQuantity: 32
		});
	});

	it('does not include repayBaseUpperBound in plan result', () => {
		const plan = buildShortCloseMarketRepayPlan({
			targetBaseDebt: 32,
			baseAsset: 0,
			quoteAsset: 31.5,
			maxQuoteQuantity: 31.5,
			estimatedBuyQuantity: { quantity: 32, quoteIn: 30.4 }
		});

		expect(plan).not.toHaveProperty('repayBaseUpperBound');
	});

	it('caps quote budget by manager quoteAsset', () => {
		const plan = buildShortCloseMarketRepayPlan({
			targetBaseDebt: 32,
			baseAsset: 0,
			quoteAsset: 20,
			maxQuoteQuantity: 20,
			estimatedBuyQuantity: { quantity: 21, quoteIn: 25 }
		});

		expect(plan.computedQuoteBudget).toBe(20);
	});

	it('returns zero budget when targetBaseDebt is zero', () => {
		const plan = buildShortCloseMarketRepayPlan({
			targetBaseDebt: 0,
			baseAsset: 0,
			quoteAsset: 31.5,
			maxQuoteQuantity: 31.5,
			estimatedBuyQuantity: null
		});

		expect(plan.computedQuoteBudget).toBe(0);
		expect(plan.computedBuyQuantity).toBe(0);
	});

	it('targetBaseDebt equals full debt regardless of baseAsset', () => {
		const plan = buildShortCloseMarketRepayPlan({
			targetBaseDebt: 32,
			baseAsset: 5,
			quoteAsset: 31.5,
			maxQuoteQuantity: 31.5,
			estimatedBuyQuantity: { quantity: 32, quoteIn: 30.4 }
		});

		expect(plan.targetBaseDebt).toBe(32);
	});

	it('uses maxQuoteQuantity as fallback when no estimate is available', () => {
		const plan = buildShortCloseMarketRepayPlan({
			targetBaseDebt: 32,
			baseAsset: 0,
			quoteAsset: 31.5,
			maxQuoteQuantity: 31.5,
			estimatedBuyQuantity: null
		});

		expect(plan.computedQuoteBudget).toBe(31.5);
		expect(plan.computedBuyQuantity).toBe(0);
	});
});

describe('DeepTrade short close tx shape validation (ref HbTrVjt9xWGsbcP5CVDCbx25sg31x77KfijYo65n3HF9)', () => {
	it('extracts correct fill from OrderInfo with executed_quantity=32, cumulative_quote=30.3968', () => {
		const summary = extractExecutionSummaryFromEvents(
			[
				{
					type: '0xdee9::order_info::OrderInfo',
					parsedJson: {
						client_order_id: '999',
						executed_quantity: '32000000000',
						cumulative_quote_quantity: '30396800',
						paid_fees: '3799'
					}
				}
			],
			'999',
			1_000_000_000,
			1_000_000
		);

		expect(summary).not.toBeNull();
		expect(summary!.filledQuantity).toBe(32);
		expect(summary!.filledQuoteQuantity).toBe(30.3968);
		expect(summary!.averageFillPrice).toBeCloseTo(0.9499, 4);
	});

	it('extracts fill from OrderFilled events as fallback', () => {
		const summary = extractExecutionSummaryFromEvents(
			[
				{
					type: '0xdee9::order_info::OrderFilled',
					parsedJson: {
						taker_client_order_id: '999',
						base_quantity: '32000000000',
						quote_quantity: '30396800'
					}
				}
			],
			'999',
			1_000_000_000,
			1_000_000
		);

		expect(summary).not.toBeNull();
		expect(summary!.filledQuantity).toBe(32);
		expect(summary!.filledQuoteQuantity).toBe(30.3968);
	});
});
