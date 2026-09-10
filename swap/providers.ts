import { assetAddress, sameAssetAddress, swapRoutes } from './routes.js';
import type { SwapRoute } from './routes.js';
import { swapConfig as config } from './config.js';
import { ceilDiv, integer, list, record, swapJson, SwapHttpError, textField, transactionHash, units } from './http.js';
import type { ProviderProgress, ProviderQuote, SwapFee, SwapInput, SwapOperation, SwapPlan, SwapProvider, SwapQuote } from './types.js';

function minimumOutput(expected: bigint): string {
    if (expected <= 0n) throw new Error('The swap has no payable output.');
    return ceilDiv(expected * BigInt(10_000 - config.slippageBps), 10_000n).toString();
}

function assertTime(expiresAt: number): void {
    if (expiresAt <= Date.now() + config.fundingMarginMs) throw new Error('Quote or deposit channel expired; obtain a new quote.');
}

function sameAddress(left: unknown, right: string): boolean {
    return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

function decimalRatio(value: unknown): [bigint, bigint] {
    const input = textField(value);
    if (!/^\d+(?:\.\d+)?$/.test(input)) throw new Error('Invalid provider price.');
    const [whole, fraction = ''] = input.split('.');
    return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)];
}

function thorMemo(quote: SwapQuote, route: SwapRoute): string {
    const interval = quote.details.streaming === true ? integer(quote.details.streamingInterval) : 1;
    const quantity = quote.details.streaming === true ? integer(quote.details.streamingQuantity) : 1;
    return `=:${route.destination.thorchain.asset}:${quote.to}/${quote.from}:${BigInt(quote.minimumBaseUnits) / route.destination.thorchain.scale}/${interval}/${quantity}`;
}

export class ThorchainSwapProvider implements SwapProvider {
    readonly id = 'thorchain' as const;
    constructor(private readonly route: SwapRoute = swapRoutes['bsc-btc']) {}

    private async inbound(): Promise<Record<string, unknown>> {
        const entries = list(await swapJson(`${config.thorchain.url}/thorchain/inbound_addresses`)).map(record);
        for (const chain of ['BSC', 'BTC']) {
            const entry = entries.find(item => item.chain === chain);
            if (!entry) throw new Error(`THORChain ${chain} trading is unavailable: chain not listed by the provider API.`);
            const reasons: string[] = [];
            for (const [field, reason] of [
                ['halted', 'chain halted'],
                ['global_trading_paused', 'global trading paused'],
                ['chain_trading_paused', 'chain trading paused']
            ]) {
                if (entry[field] === true) reasons.push(reason);
                else if (entry[field] !== false) reasons.push(`${reason} status unverified`);
            }
            if (reasons.length) {
                throw new Error(`THORChain ${chain} trading is unavailable: ${reasons.join('; ')}.`);
            }
        }
        const bsc = entries.find(item => item.chain === 'BSC')!;
        if (!sameAddress(bsc.router, config.thorchain.router)) throw new Error('THORChain router changed; integration must be reviewed.');
        const source = entries.find(item => item.chain === this.route.source.thorchain.chain)!;
        assetAddress(this.route.source, source.address);
        return source;
    }

    async quote(input: SwapInput): Promise<ProviderQuote> {
        if (input.routeId !== this.route.id) throw new Error('Swap route mismatch.');
        const amount = BigInt(input.amountBaseUnits);
        const { source, destination } = this.route;
        if (amount % source.thorchain.scale !== 0n) throw new Error('THORChain supports at most 8 USDT decimal places.');
        const inbound = await this.inbound();
        const params = new URLSearchParams({
            from_asset: source.thorchain.asset, to_asset: destination.thorchain.asset, amount: (amount / source.thorchain.scale).toString(),
            destination: input.to, refund_address: input.from,
            ...(source.network.family === 'bitcoin' ? { extended: 'true' } : {}),
            streaming_interval: String(config.thorchain.streamingInterval), streaming_quantity: String(config.thorchain.streamingQuantity), liquidity_tolerance_bps: String(config.slippageBps)
        });
        const data = record(await swapJson(`${config.thorchain.url}/thorchain/quote/swap?${params}`));
        if (data.error || (source.network.family === 'evm' && !sameAddress(data.router, config.thorchain.router)) || !sameAssetAddress(source, data.inbound_address, textField(inbound.address))) {
            throw new Error('THORChain returned an unavailable or inconsistent route.');
        }
        const recommendedMinimum = units(data.recommended_min_amount_in);
        if (amount / source.thorchain.scale < recommendedMinimum) throw new Error('Amount is below the safe THORChain minimum, including refund fees.');
        const fees = record(data.fees);
        if (textField(fees.asset).toUpperCase() !== destination.thorchain.asset || units(fees.affiliate) !== 0n) throw new Error('Unexpected THORChain fees.');
        const expectedThorUnits = units(data.expected_amount_out);
        const expected = expectedThorUnits * destination.thorchain.scale;
        const minimumBaseUnits = (BigInt(minimumOutput(expectedThorUnits)) * destination.thorchain.scale).toString();
        const expiresAt = Math.min(integer(data.expiry) * 1_000, Date.now() + config.quoteLifetimeMs);
        assertTime(expiresAt);
        const evm = source.network.family === 'evm';
        if (data.gas_rate_units !== (evm ? 'gwei' : 'satsperbyte')) throw new Error('Unexpected THORChain gas units.');
        if (!evm && amount <= units(inbound.dust_threshold)) throw new Error('Bitcoin deposit is below the THORChain dust threshold.');
        const gasPrice = units(data.recommended_gas_rate) * (evm ? 1_000_000_000n : 1n);
        return {
            provider: this.id, expectedBaseUnits: expected.toString(), minimumBaseUnits, expiresAt,
            estimatedSeconds: typeof data.total_swap_seconds === 'number' ? integer(data.total_swap_seconds) : null,
            fees: [
                { label: 'Liquidity / price impact', asset: destination.asset, amountBaseUnits: (units(fees.liquidity) * destination.thorchain.scale).toString(), decimals: destination.decimals },
                { label: `${destination.asset} payout`, asset: destination.asset, amountBaseUnits: (units(fees.outbound) * destination.thorchain.scale).toString(), decimals: destination.decimals }
            ],
            details: {
                depositAddress: assetAddress(source, data.inbound_address), ...(evm ? { router: config.thorchain.router } : {}),
                expirySeconds: integer(data.expiry), gasPrice: gasPrice.toString(),
                streaming: true, streamingInterval: config.thorchain.streamingInterval, streamingQuantity: config.thorchain.streamingQuantity,
                memo: `=:${destination.thorchain.asset}:${input.to}/${input.from}:${BigInt(minimumBaseUnits) / destination.thorchain.scale}/${config.thorchain.streamingInterval}/${config.thorchain.streamingQuantity}`
            }
        };
    }

    async prepare(quote: SwapQuote): Promise<SwapPlan> {
        const plan: SwapPlan = {
            depositAddress: assetAddress(this.route.source, quote.details.depositAddress),
            ...(this.route.source.network.family === 'evm' ? { router: config.thorchain.router } : {}),
            expiresAt: quote.expiresAt, expirySeconds: integer(quote.details.expirySeconds),
            memo: thorMemo(quote, this.route)
        };
        await this.validate(quote, plan);
        return plan;
    }

    async validate(quote: SwapQuote, plan: SwapPlan): Promise<void> {
        assertTime(Math.min(quote.expiresAt, plan.expiresAt));
        const inbound = await this.inbound();
        if (quote.routeId !== this.route.id || !sameAssetAddress(this.route.source, inbound.address, plan.depositAddress) ||
            (this.route.source.network.family === 'evm' && plan.router !== config.thorchain.router) ||
            plan.memo !== thorMemo(quote, this.route)) {
            throw new Error('THORChain vault or swap parameters changed; obtain a new quote.');
        }
        if (this.route.source.network.family === 'bitcoin' &&
            (BigInt(quote.amountBaseUnits) <= units(inbound.dust_threshold) || units(inbound.gas_rate) > BigInt(quote.funding.rate))) {
            throw new Error('THORChain Bitcoin funding requirements changed; obtain a new quote.');
        }
    }

    async status(operation: SwapOperation): Promise<ProviderProgress> {
        const { source, destination } = this.route;
        if (operation.quote.routeId !== this.route.id) throw new Error('Swap route mismatch.');
        const deposit = operation.steps.find(step => step.kind === 'deposit');
        if (!deposit) return { state: 'deposit_pending' };
        let data: Record<string, unknown>;
        try { data = record(await swapJson(`${config.thorchain.url}/thorchain/tx/status/${transactionHash(deposit.hash)}`)); }
        catch (error) {
            if (error instanceof SwapHttpError && error.status === 404) return { state: 'deposit_pending' };
            throw error;
        }
        if (!data.tx) return { state: 'deposit_pending' };
        const tx = record(data.tx);
        if (transactionHash(tx.id) !== transactionHash(deposit.hash) || tx.chain !== source.thorchain.chain ||
            !sameAssetAddress(source, tx.from_address, operation.quote.from) || tx.memo !== operation.plan?.memo) {
            throw new Error('THORChain deposit does not match this swap.');
        }
        const coins = list(tx.coins).map(record);
        if (coins.length !== 1 || textField(coins[0].asset).toUpperCase() !== source.thorchain.asset ||
            units(coins[0].amount) * source.thorchain.scale !== BigInt(operation.quote.amountBaseUnits)) {
            throw new Error('THORChain deposit asset or amount mismatch.');
        }
        const outputs = data.out_txs == null ? [] : list(data.out_txs).map(record);
        const planned = data.planned_out_txs == null ? [] : list(data.planned_out_txs).map(record);
        const stages = record(data.stages);
        const swapStatus = stages.swap_status ? record(stages.swap_status) : null;
        const progress: ProviderProgress = {
            state: 'deposit_confirmed',
            settlementComplete: swapStatus?.pending === false && !!stages.outbound_signed && record(stages.outbound_signed).completed === true &&
                planned.length > 0 && outputs.length === planned.length
        };
        for (const output of outputs) {
            const values = list(output.coins).map(record);
            for (const coin of values) {
                if (output.chain === destination.thorchain.chain && textField(coin.asset).toUpperCase() === destination.thorchain.asset && sameAssetAddress(destination, output.to_address, operation.quote.to)) {
                    if (progress.payoutHash) throw new Error('Unexpected multiple payouts.');
                    progress.payoutHash = transactionHash(output.id, destination.network.family === 'evm');
                    progress.payoutBaseUnits = (units(coin.amount) * destination.thorchain.scale).toString();
                    progress.state = 'payout_pending';
                } else if (output.chain === source.thorchain.chain && textField(coin.asset).toUpperCase() === source.thorchain.asset &&
                    sameAssetAddress(source, output.to_address, operation.quote.from) && textField(output.memo).startsWith('REFUND:')) {
                    if (progress.refundHash) throw new Error('Unexpected multiple refunds.');
                    progress.refundHash = transactionHash(output.id, source.network.family === 'evm');
                    progress.refundBaseUnits = (units(coin.amount) * source.thorchain.scale).toString();
                    progress.state = 'refund_pending';
                } else {
                    throw new Error('Unexpected THORChain payout asset or destination.');
                }
            }
        }
        if (progress.refundHash || planned.some(item => item.refund === true)) {
            try {
                const history = record(await swapJson(`${config.thorchain.midgardUrl}/v2/actions?txid=${transactionHash(deposit.hash)}`));
                const action = list(history.actions).map(record).find(item => item.type === 'refund' &&
                    list(item.in).map(record).some(input => transactionHash(input.txID) === transactionHash(deposit.hash)));
                if (action) {
                    const reason = textField(record(record(action.metadata).refund).reason).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240);
                    progress.message = `THORChain refund: ${reason}.`;
                } else progress.message = 'THORChain refund reason is not available yet.';
            } catch {
                progress.message = 'THORChain refund reason is temporarily unavailable.';
            }
        }
        if (swapStatus?.pending === true) {
            progress.state = 'swapping';
            if (swapStatus.streaming) {
                const streaming = record(swapStatus.streaming);
                progress.message = [progress.message, `Streaming: ${integer(streaming.count)} / ${integer(streaming.quantity)} swap attempts.`].filter(Boolean).join(' ');
            }
            return progress;
        }
        if (progress.payoutHash || progress.refundHash) return progress;
        if (planned.some(item => item.refund === true)) return { ...progress, state: 'refund_pending' };
        if (planned.length) return { ...progress, state: 'payout_pending' };
        if (stages.swap_finalised && record(stages.swap_finalised).completed === true) return { state: 'payout_pending' };
        if (stages.inbound_finalised && record(stages.inbound_finalised).completed === true) return { state: 'swapping' };
        return progress;
    }
}

export class ChainflipSwapProvider implements SwapProvider {
    readonly id = 'chainflip' as const;
    constructor(private readonly route: SwapRoute = swapRoutes['bsc-btc']) {}

    private async available(): Promise<void> {
        const info = record(await swapJson(`${config.chainflip.url}/api/networkInfo`));
        const assets = list(info.assets).map(record);
        const source = assets.find(asset => asset.asset === this.route.source.chainflip.id);
        const destination = assets.find(asset => asset.asset === this.route.destination.chainflip.id);
        for (const [entry, asset] of [[source, this.route.source], [destination, this.route.destination]] as const) {
            if (!entry) throw new Error(`Chainflip ${asset.label} is currently unavailable: asset not listed by the provider API.`);
        }
        for (const [entry, asset, field, action] of [
            [source!, this.route.source, 'depositChannelCreationEnabled', 'deposit channel creation'],
            [source!, this.route.source, 'depositChannelDepositsEnabled', 'deposits'],
            [destination!, this.route.destination, 'egressEnabled', 'payouts']
        ] as const) {
            if (entry[field] !== true) {
                const reason = entry[field] === false ? `${action} disabled by the provider` : `${action} status unverified`;
                throw new Error(`Chainflip ${asset.label} is currently unavailable: ${reason}.`);
            }
        }
    }

    async quote(input: SwapInput): Promise<ProviderQuote> {
        if (input.routeId !== this.route.id) throw new Error('Swap route mismatch.');
        await this.available();
        const params = new URLSearchParams({
            srcChain: this.route.source.chainflip.chain, srcAsset: this.route.source.asset, destChain: this.route.destination.chainflip.chain, destAsset: this.route.destination.asset,
            amount: input.amountBaseUnits, isVaultSwap: 'false', isOnChain: 'false', dcaV2Enabled: 'false'
        });
        const quotes = list(await swapJson(`${config.chainflip.url}/v2/quote?${params}`)).map(record);
        const regular = quotes.filter(item => item.type === 'REGULAR' && !item.dcaParams && !item.ccmParams &&
            !item.isVaultSwap && !item.isOnChain && !item.maxBoostFeeBps && item.lowLiquidityWarning !== true);
        if (!regular.length) throw new Error('Chainflip has no safe single-execution quote.');
        const data = regular.sort((a, b) => units(a.egressAmount) > units(b.egressAmount) ? -1 : 1)[0];
        const source = record(data.srcAsset);
        const target = record(data.destAsset);
        if (source.chain !== this.route.source.chainflip.chain || source.asset !== this.route.source.asset ||
            target.chain !== this.route.destination.chainflip.chain || target.asset !== this.route.destination.asset ||
            units(data.depositAmount) !== BigInt(input.amountBaseUnits)) throw new Error('Chainflip quote asset or amount mismatch.');
        const fees: SwapFee[] = [];
        let egress = 0n;
        const feeEntries = [
            ...list(data.includedFees),
            ...list(data.poolInfo).map(pool => ({ ...record(record(pool).fee), type: 'LIQUIDITY' }))
        ];
        for (const value of feeEntries) {
            const fee = record(value);
            const amount = units(fee.amount);
            if ((fee.type === 'BOOST' || fee.type === 'BROKER') && amount !== 0n) throw new Error('Unexpected Chainflip extra fee.');
            const asset = textField(fee.asset);
            const chain = textField(fee.chain);
            const decimals = asset === 'BTC' && chain === 'Bitcoin' ? 8 :
                asset === 'USDT' && chain === 'Bsc' ? 18 :
                (asset === 'USDC' || asset === 'USDT') && chain === 'Ethereum' ? 6 : null;
            if (decimals === null) throw new Error('Unsupported Chainflip fee denomination.');
            fees.push({ label: textField(fee.type), asset: `${asset} (${chain})`, amountBaseUnits: amount.toString(), decimals });
            if (fee.type === 'EGRESS') {
                if (asset !== this.route.destination.asset || chain !== this.route.destination.chainflip.chain) throw new Error('Invalid Chainflip egress fee.');
                egress += amount;
            }
        }
        const expected = units(data.egressAmount);
        const minimumBaseUnits = minimumOutput(expected);
        const [price, scale] = decimalRatio(data.estimatedPrice);
        const minPriceX128 = ceilDiv(
            price * (BigInt(minimumBaseUnits) + egress) * (1n << 128n) * 10n ** BigInt(this.route.destination.decimals),
            scale * (expected + egress) * 10n ** BigInt(this.route.source.decimals)
        );
        if (minPriceX128 <= 0n) throw new Error('Invalid Chainflip minimum price.');
        return {
            provider: this.id, expectedBaseUnits: expected.toString(), minimumBaseUnits,
            expiresAt: Date.now() + config.quoteLifetimeMs,
            estimatedSeconds: integer(data.estimatedDurationSeconds), fees,
            details: { quote: data, minPriceX128: minPriceX128.toString() }
        };
    }

    async prepare(quote: SwapQuote): Promise<SwapPlan> {
        assertTime(quote.expiresAt);
        await this.available();
        const data = record(await swapJson(`${config.chainflip.url}/api/openSwapDepositChannel`, {
            srcAsset: { chain: this.route.source.chainflip.chain, asset: this.route.source.asset },
            destAsset: { chain: this.route.destination.chainflip.chain, asset: this.route.destination.asset },
            srcAddress: quote.from, destAddress: quote.to, amount: quote.amountBaseUnits,
            maxBoostFeeBps: 0, takeCommission: false,
            fillOrKillParams: {
                refundAddress: quote.from, retryDurationBlocks: config.chainflip.refundRetryBlocks,
                minPriceX128: textField(quote.details.minPriceX128), maxOraclePriceSlippage: null
            },
            quote: record(quote.details.quote)
        }));
        if (integer(data.brokerCommissionBps) !== 0 || integer(data.maxBoostFeeBps) !== 0 || units(data.channelOpeningFee) !== 0n) {
            throw new Error('Chainflip channel introduced an unapproved fee; no funds sent.');
        }
        const expiresAt = integer(data.estimatedExpiryTime);
        const plan: SwapPlan = {
            depositAddress: assetAddress(this.route.source, data.depositAddress), providerId: textField(data.id),
            expiresAt: Math.min(quote.expiresAt, expiresAt), channelExpiryBlock: units(data.srcChainExpiryBlock).toString()
        };
        assertTime(plan.expiresAt);
        return plan;
    }

    private checkStatus(data: Record<string, unknown>, quote: SwapQuote, plan: SwapPlan): void {
        if (quote.routeId !== this.route.id || data.srcChain !== this.route.source.chainflip.chain || data.srcAsset !== this.route.source.asset ||
            data.destChain !== this.route.destination.chainflip.chain || data.destAsset !== this.route.destination.asset ||
            !sameAssetAddress(this.route.destination, data.destAddress, quote.to) || data.dcaParams || data.ccmParams) {
            throw new Error('Chainflip channel parameters do not match the accepted swap.');
        }
        const channel = record(data.depositChannel);
        if (channel.id !== plan.providerId || !sameAssetAddress(this.route.source, channel.depositAddress, plan.depositAddress) ||
            units(channel.expectedDepositAmount) !== BigInt(quote.amountBaseUnits) || channel.dcaParams) {
            throw new Error('Chainflip deposit channel mismatch.');
        }
        const protection = record(data.fillOrKillParams);
        if (!sameAssetAddress(this.route.source, protection.refundAddress, quote.from)) throw new Error('Chainflip refund address mismatch.');
        const [price, scale] = decimalRatio(protection.minPrice);
        const actual = ceilDiv(price * (1n << 128n) * 10n ** BigInt(this.route.destination.decimals), scale * 10n ** BigInt(this.route.source.decimals));
        if (actual + 1n < units(quote.details.minPriceX128)) throw new Error('Chainflip price protection is weaker than accepted.');
        if (integer(protection.retryDurationBlocks) !== config.chainflip.refundRetryBlocks) throw new Error('Chainflip refund deadline mismatch.');
        if (data.boost && units(String(record(data.boost).maxBoostFeeBps)) !== 0n) throw new Error('Unexpected boosted swap.');
    }

    async validate(quote: SwapQuote, plan: SwapPlan): Promise<void> {
        assertTime(Math.min(quote.expiresAt, plan.expiresAt));
        await this.available();
        const data = record(await swapJson(`${config.chainflip.url}/v2/swaps/${encodeURIComponent(textField(plan.providerId))}`));
        this.checkStatus(data, quote, plan);
        if (data.state !== 'WAITING' || record(data.depositChannel).isExpired !== false) throw new Error('Chainflip channel is no longer waiting for this deposit.');
    }

    async status(operation: SwapOperation): Promise<ProviderProgress> {
        if (!operation.plan?.providerId) return { state: 'deposit_pending' };
        const data = record(await swapJson(`${config.chainflip.url}/v2/swaps/${encodeURIComponent(operation.plan.providerId)}`));
        this.checkStatus(data, operation.quote, operation.plan);
        const progress: ProviderProgress = { state: 'deposit_pending' };
        if (data.deposit) {
            const deposit = record(data.deposit);
            if (units(deposit.amount) !== BigInt(operation.quote.amountBaseUnits)) throw new Error('Chainflip deposit amount mismatch.');
            if (deposit.txRef && transactionHash(deposit.txRef, this.route.source.network.family === 'evm') !== operation.steps.find(step => step.kind === 'deposit')?.hash) {
                throw new Error('Chainflip deposit transaction mismatch.');
            }
        }
        if (data.state === 'SWAPPING') progress.state = 'swapping';
        else if (data.state === 'RECEIVING') progress.state = 'deposit_confirmed';
        else if (['SENDING', 'SENT', 'COMPLETED'].includes(textField(data.state))) progress.state = 'payout_pending';
        else if (data.state === 'FAILED') {
            progress.state = 'needs_attention';
            progress.message = 'Provider reports a failure. Funds are not marked refunded until the source-asset refund is verified.';
        } else if (data.state !== 'WAITING') throw new Error('Unknown Chainflip swap state.');
        if (data.swapEgress) {
            const egress = record(data.swapEgress);
            progress.state = 'payout_pending';
            if (egress.txRef) {
                progress.payoutHash = transactionHash(egress.txRef, this.route.destination.network.family === 'evm');
                progress.payoutBaseUnits = units(egress.amount).toString();
            }
        }
        if (data.refundEgress) {
            const refund = record(data.refundEgress);
            progress.state = 'refund_pending';
            if (refund.txRef) {
                progress.refundHash = transactionHash(refund.txRef, this.route.source.network.family === 'evm');
                progress.refundBaseUnits = units(refund.amount).toString();
            }
        }
        if (data.fallbackEgress) {
            progress.state = 'needs_attention';
            progress.message = 'Provider reports an unexpected fallback payout. Check the operation before taking action.';
        }
        return progress;
    }
}

export function createSwapProviders(route: SwapRoute = swapRoutes['bsc-btc']): SwapProvider[] {
    return [new ChainflipSwapProvider(route), new ThorchainSwapProvider(route)];
}
