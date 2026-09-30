import { NetworkRegistry, TransferService, clearSensitiveData, normalizeDecimal,
    type TransferEstimate, type TransferResult, type WalletAccount } from 'hodl-wallet/browser';
import { webConfig } from '../config.mjs';
import { BrowserVault } from './vault.js';
import { VaultError } from './vault-error.js';
import { networkRequest } from './network-access.js';

export type TransferInput = { network: string; to: string; asset: string; amount: string };
export type TransferReview = TransferEstimate & {
    id: string; network: string; networkName: string; expiresAt: number;
    source: 'new' | 'saved'; transactionHash?: string; savedStatus?: TransferResult['status'];
};
export type HistoryEntry = TransferResult & { createdAt: string; networkName: string; explorer: string; error?: string };
export type TransferOutcome = { transfer: TransferResult; warning?: string };

type Scope = ReturnType<BrowserVault['scope']>;

function transferError(error: unknown): VaultError {
    if (error instanceof VaultError) return error;
    const message = error instanceof Error ? error.message : '';
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    if (message.includes('confirmed limit')) return new VaultError('The network fee increased. Review the transfer again.');
    if (/insufficient/i.test(message)) return new VaultError('Insufficient funds for the amount and network fee.');
    if (code === 'BROADCAST_UNKNOWN') return new VaultError('The broadcast outcome is unknown. Check local activity before attempting another payment.');
    if (code === 'SWAP_IN_PROGRESS') return new VaultError('An active swap must settle before another transfer on this network.');
    if (code === 'TRANSFER_FAILED' && message === 'The transaction was mined but reverted.') return new VaultError('The transaction was confirmed but reverted.');
    if (error instanceof TypeError) return new VaultError('Enter a positive decimal amount with the correct number of decimal places.');
    return new VaultError('The network could not complete this request. Refresh local activity before trying again.');
}

export class BrowserTransfers {
    private readonly registry = new NetworkRegistry();
    private review?: { value: TransferReview; scope: Scope };
    private active = false;

    constructor(private readonly vault: BrowserVault) {}

    reset(): void { this.review = undefined; }

    private begin(): Scope {
        if (this.active) throw new VaultError('Another transfer operation is in progress.');
        const scope = this.vault.scope();
        this.active = true;
        return scope;
    }

    private service(networkId: string, scope: Scope) {
        const plugin = this.registry.get(networkId);
        const network = new plugin.NetworkClass(plugin);
        const status = network.getTransactionStatus.bind(network);
        network.getTransactionStatus = hash => networkRequest(() => status(hash), scope.check);
        return { plugin, network, service: new TransferService(scope.store, plugin, network) };
    }

    async estimate(input: TransferInput): Promise<TransferReview> {
        const scope = this.begin();
        this.review = undefined;
        try {
            const { plugin, network, service } = this.service(input.network, scope);
            const to = input.to.trim();
            if (!network.validateAddress(to)) throw new VaultError('Enter a valid recipient address for this network.');
            const asset = input.asset.toUpperCase();
            if (asset !== plugin.nativeToken && !plugin.tokens[asset]) throw new VaultError('Choose an asset configured for this network.');
            const amount = normalizeDecimal(input.amount.trim());
            const address = await scope.store.get('account', plugin.NetworkClass.name, 'address');
            if (typeof address !== 'string') throw new VaultError('This wallet has no account for the selected network.');
            const unresolved = (await service.list()).find(transfer => ['prepared', 'broadcasting', 'broadcast_unknown'].includes(transfer.status));
            if (unresolved) throw new VaultError('Resolve the saved transfer in local activity before creating another payment on this network.');
            const estimate = await networkRequest(() => network.estimateTransfer(address, to, amount, asset), scope.check);
            const value: TransferReview = { ...estimate, id: crypto.randomUUID(), network: plugin.id,
                networkName: plugin.name.replace(/^\[[^\]]+\]\s*/, ''),
                expiresAt: Date.now() + webConfig.transfer.reviewTtlMs, source: 'new' };
            this.review = { value, scope };
            return structuredClone(value);
        } catch (error) { throw transferError(error); }
        finally { this.active = false; }
    }

    /** What `max` would send and the fee it would pay. Signs nothing and stores nothing. */
    async preview(networkId: string, to: string, asset: string): Promise<{ amount: string; fee: TransferEstimate['fee'] }> {
        const scope = this.begin();
        try {
            const { plugin, network } = this.service(networkId, scope);
            if (!network.validateAddress(to.trim())) throw new VaultError('Enter a valid recipient address for this network.');
            const symbol = asset.toUpperCase();
            if (symbol !== plugin.nativeToken && !plugin.tokens[symbol]) throw new VaultError('Choose an asset configured for this network.');
            const address = await scope.store.get('account', plugin.NetworkClass.name, 'address');
            if (typeof address !== 'string') throw new VaultError('This wallet has no account for the selected network.');
            const { amount, fee } = await networkRequest(() => network.estimateTransfer(address, to.trim(), 'max', symbol), scope.check);
            return { amount, fee };
        } catch (error) { throw transferError(error); }
        finally { this.active = false; }
    }

    /** Saved transfers on one network whose broadcast still needs the user's decision. */
    async unresolved(networkId: string): Promise<TransferResult[]> {
        const scope = this.begin();
        try {
            const saved = await this.service(networkId, scope).service.list();
            scope.check();
            return saved.filter(transfer => ['prepared', 'broadcasting', 'broadcast_unknown'].includes(transfer.status));
        } finally { this.active = false; }
    }

    async reviewSaved(networkId: string, requestId: string): Promise<TransferReview> {
        const scope = this.begin();
        this.review = undefined;
        try {
            const { plugin, service } = this.service(networkId, scope);
            const saved = (await service.list()).find(transfer => transfer.requestId === requestId);
            if (!saved || !['prepared', 'broadcasting', 'broadcast_unknown'].includes(saved.status)) throw new VaultError('This transfer is not awaiting broadcast recovery. Refresh local activity.');
            const value: TransferReview = { from: saved.from, to: saved.to, asset: saved.asset,
                amount: saved.amount, amountBaseUnits: saved.amountBaseUnits, fee: saved.fee,
                id: requestId, network: plugin.id, networkName: plugin.name.replace(/^\[[^\]]+\]\s*/, ''),
                expiresAt: Date.now() + webConfig.transfer.reviewTtlMs, source: 'saved', transactionHash: saved.transactionHash, savedStatus: saved.status };
            this.review = { value, scope };
            return structuredClone(value);
        } catch (error) { throw transferError(error); }
        finally { this.active = false; }
    }

    async confirm(reviewId: string, onBroadcast: () => void): Promise<TransferOutcome> {
        if (this.active) throw new VaultError('Another transfer operation is in progress.');
        const review = this.review;
        if (!review || review.value.id !== reviewId) throw new VaultError('Review this transfer before confirming it.');
        this.review = undefined;
        const { value, scope } = review;
        const consent = () => {
            scope.check();
            if (Date.now() >= value.expiresAt) throw new VaultError('This review expired. Review the transfer again.');
        };
        consent();
        this.active = true;
        const { network, service } = this.service(value.network, scope);
        const prepare = network.prepareTransfer.bind(network);
        const broadcast = network.sendSignedTransaction.bind(network);
        network.prepareTransfer = async (account, to, amount, asset) => {
            let finished = false;
            const check = () => {
                consent();
                if (finished) throw new VaultError('Transfer preparation was canceled.');
            };
            const guarded: WalletAccount = { address: account.address,
                get privateKey() { check(); return account.privateKey; } };
            let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
            try {
                prepared = await networkRequest(() => prepare(guarded, to, amount, asset, { maxFeeBaseUnits: value.fee.baseUnits }), check);
                return prepared;
            } catch (error) { clearSensitiveData(prepared); throw error; }
            finally { finished = true; }
        };
        network.sendSignedTransaction = async raw => {
            consent();
            onBroadcast();
            return networkRequest(() => broadcast(raw), scope.check);
        };
        try {
            if (value.source === 'saved') {
                const saved = (await service.list()).find(transfer => transfer.requestId === value.id);
                if (!saved || saved.transactionHash !== value.transactionHash) throw new VaultError('The saved transfer changed. Refresh local activity.');
            }
            const transfer = await service.send({ wallet: 'primary', to: value.to, asset: value.asset,
                amount: value.amount, requestId: value.id, dryRun: false });
            return { transfer };
        } catch (error) {
            scope.check();
            const saved = (await service.list()).find(transfer => transfer.requestId === value.id);
            if (saved) return { transfer: saved, warning: transferError(error).message };
            throw transferError(error);
        } finally { this.active = false; }
    }

    async history(refresh: boolean, networkId?: string): Promise<HistoryEntry[]> {
        const scope = this.begin();
        try {
            const entries: HistoryEntry[] = [];
            for (const plugin of this.registry.list().filter(candidate => networkId === undefined || candidate.id === networkId)) {
                const { service } = this.service(plugin.id, scope);
                for (const saved of await service.list()) {
                    let current: TransferResult = saved;
                    let error: string | undefined;
                    if (refresh && !['confirmed', 'failed'].includes(saved.status)) {
                        try { current = await service.track(saved.requestId!); }
                        catch (failure) { scope.check(); error = transferError(failure).message; }
                    }
                    entries.push({ ...current, createdAt: saved.createdAt,
                        networkName: plugin.name.replace(/^\[[^\]]+\]\s*/, ''),
                        explorer: plugin.explorer, ...(error ? { error } : {}) });
                }
            }
            scope.check();
            return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        } finally { this.active = false; }
    }
}
