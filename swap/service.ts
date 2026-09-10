import crypto from 'node:crypto';
import { AgentError } from '../agent-errors.js';
import { formatUnits, normalizeDecimal, parseDecimalToUnits } from '../amounts.js';
import Persist from '../persist.js';
import { BitcoinSwapChain } from './bitcoin.js';
import { assetAddress, sameAssetAddress, swapRoute } from './routes.js';
import type { SwapRoute } from './routes.js';
import { readSwapOperation, readSwapQuote } from './storage.js';
import { BscSwapChain } from './chain.js';
import { swapConfig as config } from './config.js';
import { ceilDiv, integer, record, swapJson } from './http.js';
import { createSwapProviders } from './providers.js';
import { terminalSwapStates } from './types.js';
import type { SwapRouteId, SwapChain, SwapInput, SwapOperation, SwapPrices, SwapProvider, SwapQuote, SwapState, SwapStep, ProviderProgress } from './types.js';
import type { WalletAccount } from '../network/types.js';

export type SwapServiceOptions = {
    routeId?: SwapRouteId;
    chain?: SwapChain;
    providers?: SwapProvider[];
    prices?: () => Promise<SwapPrices>;
};

async function loadPrices(): Promise<SwapPrices> {
    const response = record(await swapJson(config.pricesUrl));
    const prices: Record<string, string> = {};
    let updatedAt = Date.now();
    for (const [id, key] of [['bitcoin', 'btc'], ['binancecoin', 'bnb'], ['tether', 'usdt']]) {
        const entry = record(response[id]);
        if (typeof entry.usd !== 'number' || !Number.isFinite(entry.usd) || entry.usd <= 0) throw new Error('Invalid reference price.');
        prices[key] = parseDecimalToUnits(entry.usd.toFixed(8), 8).toString();
        const at = integer(entry.last_updated_at) * 1_000;
        if (Date.now() - at > config.referenceMaxAgeMs || at - Date.now() > config.clockSkewMs) throw new Error('Reference prices are stale.');
        updatedAt = Math.min(updatedAt, at);
    }
    return { btc: prices.btc, bnb: prices.bnb, usdt: prices.usdt, updatedAt };
}

export async function assertNoActiveSwap(db: Persist): Promise<void> {
    const operations = await db.entries('swapOperation') as Array<[string, SwapOperation]> || [];
    try {
        const active = operations.find(([, operation]) => !terminalSwapStates.includes(operation.state));
        if (active) throw new AgentError('SWAP_IN_PROGRESS', 'Finish or inspect the existing swap before another transfer.', 3, { requestId: active[0] });
    } finally { operations.forEach(([, operation]) => Persist.clearSensitiveData(operation)); }
}

export class SwapService {
    readonly route: SwapRoute;
    private readonly prices: () => Promise<SwapPrices>;

    constructor(private readonly db: Persist, private readonly options: SwapServiceOptions = {}) {
        this.route = swapRoute(options.routeId || 'bsc-btc');
        this.prices = options.prices || loadPrices;
    }

    private chain(routeId: SwapRouteId): SwapChain {
        if (this.options.chain && routeId === this.route.id) return this.options.chain;
        return routeId === 'bsc-btc' ? new BscSwapChain() : new BitcoinSwapChain();
    }

    private providers(routeId: SwapRouteId): SwapProvider[] {
        return this.options.providers || createSwapProviders(swapRoute(routeId));
    }

    async destination(): Promise<string | null> {
        const account = await this.db.get('account', this.route.destination.network.NetworkClass.name) as WalletAccount | undefined;
        try { return account?.address || null; }
        finally { Persist.clearSensitiveData(account); }
    }

    async availableBalance(): Promise<bigint> {
        const account = await this.source(this.route);
        const address = account.address;
        Persist.clearSensitiveData(account);
        return this.chain(this.route.id).availableBalance(address);
    }

    async quote(amount: string, destination?: string): Promise<{
        quotes: Array<ReturnType<SwapService['quoteView']> & { sufficientAsset: boolean; sufficientFee: boolean; sufficientUsdt?: boolean; sufficientBnb?: boolean }>;
        unavailable: Array<{ provider: string; reason: string }>;
        recommendedQuoteId: string | null;
    }> {
        const account = await this.source(this.route);
        const from = account.address;
        Persist.clearSensitiveData(account);
        const to = destination || await this.destination();
        if (!to) throw new AgentError('ACCOUNT_NOT_FOUND', `No ${this.route.destination.label} account configured; provide a ${this.route.destination.network.id === 'btc' ? 'Bitcoin' : 'BSC'} destination address.`, 3);
        try { assetAddress(this.route.destination, to); }
        catch { throw new AgentError('INVALID_ARGUMENT', `Invalid ${this.route.destination.network.id === 'btc' ? 'Bitcoin mainnet' : 'BSC'} destination.`, 2); }
        let normalized: string;
        let baseUnits: bigint;
        try { normalized = normalizeDecimal(amount); baseUnits = parseDecimalToUnits(normalized, this.route.source.decimals); }
        catch (error) { throw new AgentError('INVALID_ARGUMENT', (error as Error).message, 2); }
        const input: SwapInput = { routeId: this.route.id, from, to, amount: normalized, amountBaseUnits: baseUnits.toString() };
        const reference = await this.prices();
        const chain = this.chain(this.route.id);
        const providers = this.providers(this.route.id);
        const results = await Promise.allSettled(providers.map(provider => provider.quote(input)));
        const quotes: SwapQuote[] = [];
        const unavailable: Array<{ provider: string; reason: string }> = [];
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.status === 'rejected') {
                unavailable.push({ provider: providers[i].id, reason: safeMessage(result.reason) });
                continue;
            }
            try {
                const offer = result.value;
                const funding = await chain.estimate(input, offer);
                const { source, destination } = this.route;
                const fee = BigInt(funding.budgetBaseUnits);
                const feeUsd = ceilDiv(fee * BigInt(reference[funding.price]), 10n ** BigInt(funding.decimals));
                const feeOutput = ceilDiv(feeUsd * 10n ** BigInt(destination.decimals), BigInt(reference[destination.price]));
                const inputUsd = baseUnits * BigInt(reference[source.price]) / 10n ** BigInt(source.decimals);
                const outputUsd = BigInt(offer.expectedBaseUnits) * BigInt(reference[destination.price]) / 10n ** BigInt(destination.decimals);
                if (inputUsd === 0n) throw new Error('Swap amount is below reference-price precision.');
                const cost = inputUsd + feeUsd - outputUsd;
                const quote: SwapQuote = {
                    ...input, ...offer, id: crypto.randomUUID(), createdAt: Date.now(), funding,
                    netOutputBaseUnits: (BigInt(offer.expectedBaseUnits) - feeOutput).toString(),
                    costBps: Number(cost * 10_000n / inputUsd), costUsd: formatUnits(cost, 8), reference
                };
                await this.db.set('swapQuote', quote.id, quote);
                quotes.push(quote);
            } catch (error) { unavailable.push({ provider: providers[i].id, reason: safeMessage(error) }); }
        }
        quotes.sort((a, b) => BigInt(a.netOutputBaseUnits) > BigInt(b.netOutputBaseUnits) ? -1 : 1);
        await this.db.flush();
        return {
            quotes: await Promise.all(quotes.map(async quote => {
                const balance = await chain.balance(input, quote.funding);
                return { ...this.quoteView(quote), ...balance,
                    ...(this.route.id === 'bsc-btc' ? { sufficientUsdt: balance.sufficientAsset, sufficientBnb: balance.sufficientFee } : {}) };
            })),
            unavailable,
            recommendedQuoteId: quotes[0]?.id || null
        };
    }

    async execute(quoteId: string, requestId: string): Promise<ReturnType<SwapService['view']>> {
        validateId(requestId);
        validateId(quoteId);
        const previous = await this.db.get('swapOperation', requestId) as SwapOperation | undefined;
        if (previous) {
            const previousQuoteId = previous.quote.id;
            Persist.clearSensitiveData(previous);
            if (previousQuoteId !== quoteId) throw new AgentError('IDEMPOTENCY_CONFLICT', 'Request ID is bound to another swap quote.', 3);
            return this.resume(requestId);
        }
        await assertNoActiveSwap(this.db);
        const storedQuote = await this.db.get('swapQuote', quoteId);
        if (!storedQuote) throw new AgentError('INVALID_ARGUMENT', 'Swap quote not found.', 2);
        const quote = readSwapQuote(storedQuote);
        const route = swapRoute(quote.routeId);
        const chain = this.chain(route.id);
        this.assertFresh(quote);
        const operations = await this.db.entries('swapOperation') as Array<[string, SwapOperation]> || [];
        const used = operations.some(([, operation]) => operation.quote.id === quoteId);
        operations.forEach(([, operation]) => Persist.clearSensitiveData(operation));
        if (used) {
            throw new AgentError('IDEMPOTENCY_CONFLICT', 'This quote was already used. Resume its existing request ID.', 3);
        }
        await this.assertNoPendingSend(route);
        const account = await this.source(route);
        try {
            if (!sameAssetAddress(route.source, account.address, quote.from)) throw new Error('Source wallet changed since quotation.');
        } finally { Persist.clearSensitiveData(account); }
        await chain.checkFunding(quote, []);
        await chain.assertAvailable(quote.from);
        const now = Date.now();
        const operation: SwapOperation = {
            id: requestId, quote, state: 'preparing', createdAt: now, updatedAt: now,
            steps: [], history: [{ state: 'preparing', at: now }]
        };
        await this.save(operation);
        return this.resume(requestId);
    }

    async resume(requestId: string): Promise<ReturnType<SwapService['view']>> {
        const operation = await this.get(requestId);
        const route = swapRoute(operation.quote.routeId);
        const chain = this.chain(route.id);
        try {
            if (terminalSwapStates.includes(operation.state)) return this.view(operation);
            await this.refresh(operation);
            if (terminalSwapStates.includes(operation.state)) return this.view(operation);
            const deposit = operation.steps.find(step => step.kind === 'deposit');
            if (deposit?.confirmed) return this.view(operation);
            const provider = this.provider(operation.quote.provider, operation.quote.routeId);
            const pending = operation.steps.find(step => !step.confirmed);
            if (pending?.broadcastAttempted) {
                const receipt = await chain.receipt(pending.hash);
                if (receipt.state !== 'not_found') return this.view(operation);
                this.assertFresh(operation.quote);
                if (pending.kind === 'deposit') {
                    await provider.validate(operation.quote, operation.plan!);
                    await this.checkChannelBlock(operation);
                }
                await this.broadcast(operation, pending);
                return this.view(operation);
            }
            this.assertFresh(operation.quote);
            if (!operation.plan) {
                if (operation.openingChannel) {
                    this.transition(operation, 'failed', 'Deposit channel creation was interrupted. No deposit was sent; obtain a new quote.');
                    await this.save(operation);
                    return this.view(operation);
                }
                operation.openingChannel = true;
                await this.save(operation);
                operation.plan = await provider.prepare(operation.quote);
                operation.openingChannel = false;
                await this.save(operation);
            }
            await provider.validate(operation.quote, operation.plan);
            await this.checkChannelBlock(operation);
            await chain.checkFunding(operation.quote, operation.steps);
            if (pending) {
                await this.broadcast(operation, pending);
                return this.view(operation);
            }
            const kind = await chain.nextStep(operation.quote, operation.plan, operation.steps);
            if (operation.steps.some(step => step.kind === kind)) throw new Error('Unexpected repeated funding step; inspect the source account.');
            const account = await this.source(route);
            let step: SwapStep;
            try { step = await chain.sign(operation.quote, operation.plan, kind, account); }
            finally { Persist.clearSensitiveData(account); }
            operation.steps.push(step);
            await this.save(operation);
            await this.broadcast(operation, step);
            return this.view(operation);
        } catch (error) {
            operation.updateError = safeMessage(error);
            if (!operation.steps.some(step => step.kind === 'deposit' && step.broadcastAttempted)) {
                this.transition(operation, 'failed', 'No deposit was sent. Obtain a new quote; any paid network fees are not refundable.');
            }
            await this.save(operation);
            return this.view(operation);
        } finally { Persist.clearSensitiveData(operation); }
    }

    async status(requestId: string): Promise<ReturnType<SwapService['view']>> {
        const operation = await this.get(requestId);
        try {
            if (operation.state !== 'failed') await this.refresh(operation);
            return this.view(operation);
        } finally { Persist.clearSensitiveData(operation); }
    }

    async list(): Promise<ReturnType<SwapService['view']>[]> {
        const entries = await this.db.entries('swapOperation') as Array<[string, SwapOperation]> || [];
        try { return entries.map(([, operation]) => this.view(readSwapOperation(operation))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
        finally { entries.forEach(([, operation]) => Persist.clearSensitiveData(operation)); }
    }

    private async refresh(operation: SwapOperation): Promise<void> {
        const route = swapRoute(operation.quote.routeId);
        const chain = this.chain(route.id);
        try {
            delete operation.updateError;
            const trackEarly = operation.quote.provider === 'thorchain' && operation.quote.details.streaming === true;
            const pending = operation.steps.find(step => !step.confirmed);
            if (pending) {
                const receipt = await chain.receipt(pending.hash);
                if (receipt.state === 'reverted') {
                    this.transition(operation, 'failed', 'The funding transaction reverted. The deposit was not transferred; paid fees are not refundable.');
                    await this.save(operation);
                    return;
                }
                if (receipt.state !== 'confirmed' && (pending.kind !== 'deposit' || !trackEarly)) {
                    operation.lastCheckedAt = Date.now();
                    await this.save(operation);
                    return;
                }
                if (receipt.state === 'confirmed') {
                    pending.confirmed = true;
                    this.transition(operation, pending.kind === 'deposit' ? 'deposit_confirmed' : 'preparing');
                }
            }
            const deposit = operation.steps.find(step => step.kind === 'deposit' && (step.confirmed || (step.broadcastAttempted && trackEarly)));
            if (deposit) {
                const progress = await this.provider(operation.quote.provider, operation.quote.routeId).status(operation);
                if (progress.payoutHash) { operation.payoutHash = progress.payoutHash; operation.payoutBaseUnits = progress.payoutBaseUnits; }
                if (progress.refundHash) { operation.refundHash = progress.refundHash; operation.refundBaseUnits = progress.refundBaseUnits; }
                if (!operation.payoutHash && !operation.refundHash) this.transition(operation, progress.state, progress.message);
                if (operation.quote.provider === 'thorchain' && operation.quote.details.streaming === true) {
                    await this.verifyStreamingResult(operation, deposit.confirmed ? progress : { ...progress, settlementComplete: false });
                } else if (operation.payoutHash && operation.refundHash) {
                    this.transition(operation, 'needs_attention', 'Unexpected partial result: payout and refund both exist. Inspect both transactions.');
                } else if (operation.payoutHash) {
                    const payment = await chain.payoutPayment(operation.payoutHash, operation.quote.to);
                    operation.confirmations = payment.confirmations;
                    if (payment.amount === 0n && payment.confirmations === 0) {
                        this.transition(operation, route.destination.pendingState);
                    } else if (!operation.payoutBaseUnits || payment.amount !== BigInt(operation.payoutBaseUnits) || payment.amount < BigInt(operation.quote.minimumBaseUnits)) {
                        this.transition(operation, 'needs_attention', 'Destination payout amount or destination does not match the accepted swap.');
                    } else {
                        this.transition(operation, payment.confirmations >= route.destination.confirmations ? 'completed' : payment.confirmations ? route.destination.confirmingState : route.destination.pendingState);
                    }
                } else if (operation.refundHash) {
                    const refund = await chain.refundPayment(operation.refundHash, operation.quote.from);
                    operation.refundConfirmations = refund.confirmations;
                    if (refund.confirmations >= route.source.confirmations &&
                        (!operation.refundBaseUnits || refund.amount !== BigInt(operation.refundBaseUnits) || refund.amount <= 0n || refund.amount > BigInt(operation.quote.amountBaseUnits))) {
                        this.transition(operation, 'needs_attention', 'Source refund amount or destination does not match the provider result.');
                    } else if (refund.amount > 0n && refund.confirmations >= route.source.confirmations) {
                        this.transition(operation, 'refunded', `${route.source.label} refund verified. Network and provider fees may have been deducted.`);
                    } else this.transition(operation, 'refund_pending');
                }
            }
            operation.lastCheckedAt = Date.now();
        } catch (error) {
            operation.updateError = safeMessage(error);
        }
        await this.save(operation);
    }

    private async verifyStreamingResult(operation: SwapOperation, progress: ProviderProgress): Promise<void> {
        const route = swapRoute(operation.quote.routeId);
        const chain = this.chain(route.id);
        const partial = !!operation.payoutHash && !!operation.refundHash;
        let payoutConfirmed = false;
        let refundConfirmed = false;
        if (operation.payoutHash) {
            const payment = await chain.payoutPayment(operation.payoutHash, operation.quote.to);
            operation.confirmations = payment.confirmations;
            if ((payment.amount > 0n || payment.confirmations >= route.destination.confirmations) &&
                (!operation.payoutBaseUnits || payment.amount !== BigInt(operation.payoutBaseUnits) || payment.amount <= 0n)) {
                this.transition(operation, 'needs_attention', 'Destination payout amount or destination does not match the provider result.');
                return;
            }
            payoutConfirmed = payment.confirmations >= route.destination.confirmations;
        }
        if (operation.refundHash) {
            const refund = await chain.refundPayment(operation.refundHash, operation.quote.from);
            operation.refundConfirmations = refund.confirmations;
            refundConfirmed = refund.confirmations >= route.source.confirmations;
            if (refundConfirmed && (!operation.refundBaseUnits || refund.amount !== BigInt(operation.refundBaseUnits) ||
                refund.amount <= 0n || refund.amount > BigInt(operation.quote.amountBaseUnits) ||
                (partial && refund.amount === BigInt(operation.quote.amountBaseUnits)))) {
                this.transition(operation, 'needs_attention', 'Source refund amount or destination does not match the provider result.');
                return;
            }
        }
        if (progress.settlementComplete !== true) {
            this.transition(operation, partial ? 'partial_pending' : progress.state, progress.message || 'Waiting for THORChain to finish the stream and report all payouts.');
        } else if (partial) {
            this.transition(operation, payoutConfirmed && refundConfirmed ? 'partial_completed' : 'partial_pending',
                [progress.message, `Partial swap: ${route.destination.label} for the exchanged portion and ${route.source.label} returned for the remainder, minus applicable fees.`].filter(Boolean).join(' '));
        } else if (operation.payoutHash) {
            if (BigInt(operation.payoutBaseUnits!) < BigInt(operation.quote.minimumBaseUnits)) {
                this.transition(operation, 'needs_attention', 'Destination payout is below the accepted minimum without a source refund.');
            } else this.transition(operation, payoutConfirmed ? 'completed' : operation.confirmations ? route.destination.confirmingState : route.destination.pendingState);
        } else if (operation.refundHash) {
            this.transition(operation, refundConfirmed ? 'refunded' : 'refund_pending',
                [progress.message, `${route.source.label} returned, minus applicable fees.`].filter(Boolean).join(' '));
        } else this.transition(operation, 'needs_attention', 'THORChain finished without a verifiable payout or refund.');
    }

    private async broadcast(operation: SwapOperation, step: SwapStep): Promise<void> {
        this.assertFresh(operation.quote);
        await this.provider(operation.quote.provider, operation.quote.routeId).validate(operation.quote, operation.plan!);
        await this.checkChannelBlock(operation);
        step.broadcastAttempted = true;
        this.transition(operation, step.kind === 'deposit' ? 'deposit_pending' : 'approval_pending');
        await this.save(operation);
        try { await this.chain(operation.quote.routeId).broadcast(step); delete operation.updateError; }
        catch { operation.updateError = 'Broadcast result is uncertain. Track the stored transaction; do not create another swap.'; }
        await this.save(operation);
    }

    private async checkChannelBlock(operation: SwapOperation): Promise<void> {
        if (operation.plan?.channelExpiryBlock && await this.chain(operation.quote.routeId).blockNumber() >= BigInt(operation.plan.channelExpiryBlock)) {
            throw new Error('Chainflip deposit channel expired; do not send the deposit.');
        }
    }

    private assertFresh(quote: SwapQuote): void {
        if (quote.expiresAt <= Date.now() + config.fundingMarginMs) throw new AgentError('SWAP_QUOTE_EXPIRED', 'Quote expired. Obtain and confirm a new quote.', 3);
    }

    private async assertNoPendingSend(route: SwapRoute): Promise<void> {
        const sends = await this.db.entries('sendRequest') as Array<[string, { network: string; state: string }]> || [];
        if (sends.some(([, send]) => send.network === route.source.network.id && !['confirmed', 'failed'].includes(send.state))) {
            throw new AgentError('BROADCAST_UNKNOWN', `Resolve the existing ${route.source.network.id.toUpperCase()} transfer before starting a swap.`, 3);
        }
    }

    private async source(route: SwapRoute): Promise<WalletAccount> {
        const account = await this.db.get('account', route.source.network.NetworkClass.name) as WalletAccount | undefined;
        if (!account) throw new AgentError('ACCOUNT_NOT_FOUND', `Wallet has no ${route.source.label} account for the deposit.`, 3);
        return account;
    }

    private provider(id: string, routeId: SwapRouteId): SwapProvider {
        const provider = this.providers(routeId).find(item => item.id === id);
        if (!provider) throw new Error('Swap provider is not configured.');
        return provider;
    }

    private async get(requestId: string): Promise<SwapOperation> {
        validateId(requestId);
        const operation = await this.db.get('swapOperation', requestId) as SwapOperation | undefined;
        if (!operation) throw new AgentError('INVALID_ARGUMENT', 'Swap not found.', 2);
        return readSwapOperation(operation);
    }

    private transition(operation: SwapOperation, state: SwapState, message?: string): void {
        if (operation.state !== state) operation.history.push({ state, at: Date.now() });
        operation.state = state;
        operation.message = message;
    }

    private async save(operation: SwapOperation): Promise<void> {
        operation.updatedAt = Date.now();
        await this.db.set('swapOperation', operation.id, operation);
        await this.db.flush();
    }

    quoteView(quote: SwapQuote) {
        const route = swapRoute(quote.routeId);
        const funding = quote.funding;
        return {
            quoteId: quote.id, routeId: route.id, provider: quote.provider, from: quote.from, to: quote.to,
            source: { network: route.source.network.id, asset: route.source.asset, amount: quote.amount },
            destination: { network: route.destination.network.id, asset: route.destination.asset, estimated: formatUnits(quote.expectedBaseUnits, route.destination.decimals), minimum: formatUnits(quote.minimumBaseUnits, route.destination.decimals), confirmations: route.destination.confirmations },
            funding: { asset: funding.asset, budget: formatUnits(funding.budgetBaseUnits, funding.decimals), rate: funding.rate, rateUnit: funding.asset === 'BNB' ? 'wei/gas' : 'sat/vB' },
            ...(route.id === 'bsc-btc' ? { gas: { asset: 'BNB', budget: formatUnits(funding.budgetBaseUnits, funding.decimals), gasPriceWei: funding.rate, maximumGasUnits: funding.units }, netAfterGasBtcEquivalent: formatUnits(quote.netOutputBaseUnits, 8) } : {}),
            includedFees: quote.fees.map(fee => ({ label: fee.label, asset: fee.asset, amount: formatUnits(fee.amountBaseUnits, fee.decimals) })),
            estimatedTotalCost: { usd: quote.costUsd, percent: formatUnits(BigInt(quote.costBps), 2), referenceUpdatedAt: new Date(quote.reference.updatedAt).toISOString() },
            netOutputEquivalent: formatUnits(quote.netOutputBaseUnits, route.destination.decimals),
            slippagePercent: config.slippageBps / 100,
            estimatedSeconds: quote.estimatedSeconds,
            execution: quote.details.streaming === true ? 'streaming' : 'single',
            expiresAt: new Date(quote.expiresAt).toISOString(),
            refund: { asset: route.source.asset, network: route.source.network.id, address: quote.from, feesMayBeDeducted: true, partialResultPossible: quote.details.streaming === true }
        };
    }

    private view(operation: SwapOperation) {
        const route = swapRoute(operation.quote.routeId);
        return {
            requestId: operation.id, state: operation.state, quote: this.quoteView(operation.quote),
            createdAt: new Date(operation.createdAt).toISOString(), updatedAt: new Date(operation.updatedAt).toISOString(),
            lastCheckedAt: operation.lastCheckedAt ? new Date(operation.lastCheckedAt).toISOString() : null,
            message: operation.message || null, updateError: operation.updateError || null,
            delayed: !terminalSwapStates.includes(operation.state) && Date.now() - operation.createdAt > config.attentionAfterMs,
            confirmations: operation.confirmations || 0, requiredConfirmations: route.destination.confirmations,
            refundConfirmations: operation.refundConfirmations || 0, requiredRefundConfirmations: route.source.confirmations,
            providerId: operation.plan?.providerId || null,
            transactions: operation.steps.map(step => ({ kind: step.kind, hash: step.hash, confirmed: step.confirmed, explorer: `${route.source.network.explorer}${step.hash}` })),
            payout: operation.payoutHash ? { hash: operation.payoutHash, amount: operation.payoutBaseUnits ? formatUnits(operation.payoutBaseUnits, route.destination.decimals) : null, explorer: `${route.destination.network.explorer}${operation.payoutHash}` } : null,
            refund: operation.refundHash ? { hash: operation.refundHash, amount: operation.refundBaseUnits ? formatUnits(operation.refundBaseUnits, route.source.decimals) : null, explorer: `${route.source.network.explorer}${operation.refundHash}` } : null,
            history: operation.history.map(entry => ({ state: entry.state, at: new Date(entry.at).toISOString() }))
        };
    }
}

function validateId(id: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new AgentError('INVALID_ARGUMENT', 'Invalid swap request or quote ID.', 2);
}

function safeMessage(error: unknown): string {
    return error instanceof Error ? error.message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240) : 'Swap provider is unavailable.';
}
