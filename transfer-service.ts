import crypto from 'node:crypto';
import { normalizeDecimal } from './amounts.js';
import { AgentError } from './agent-errors.js';
import Persist from './persist.js';
import { assertNoActiveSwap } from './swap/service.js';
import type { BaseNetworkContract, NetworkPlugin, PreparedTransfer, TransactionStatus, WalletAccount } from './network/types.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type StoredSendRequest = PreparedTransfer & {
    fingerprint: string;
    state: 'prepared' | 'broadcasting' | 'submitted' | 'confirmed' | 'failed' | 'broadcast_unknown';
    network: string;
    createdAt: string;
    updatedAt: string;
};

type TransferRequest = {
    wallet: string;
    to: string;
    asset: string;
    amount: string;
    dryRun: boolean;
    requestId?: string;
};

export type TransferResult = Omit<PreparedTransfer, 'rawTransaction'> & {
    network: string;
    status: StoredSendRequest['state'] | 'dry-run';
    requestId?: string;
};

// The caller owns the connected database and holds its profile lock.
export class TransferService {
    constructor(
        private readonly db: Persist,
        private readonly plugin: NetworkPlugin,
        private readonly network: BaseNetworkContract
    ) {}

    async list(): Promise<Array<TransferResult & { createdAt: string }>> {
        const entries = await this.db.entries('sendRequest') as Array<[string, StoredSendRequest]> || [];
        try {
            return entries.filter(([, stored]) => stored.network === this.plugin.id)
                .map(([id, stored]) => ({ ...this.publicTransfer(stored, stored.state, id), createdAt: stored.createdAt }));
        } finally {
            Persist.clearSensitiveData(entries);
        }
    }

    async send(request: TransferRequest): Promise<TransferResult> {
        const asset = request.asset.toUpperCase();
        if (asset !== this.plugin.nativeToken && !this.plugin.tokens[asset]) {
            throw new AgentError('INVALID_ARGUMENT', `Asset ${asset} is not configured for ${this.plugin.id}.`, 2);
        }
        let amount: string;
        try { amount = normalizeDecimal(request.amount); }
        catch (error) { throw new AgentError('INVALID_ARGUMENT', (error as Error).message, 2); }
        if (!request.dryRun && (!request.requestId || !REQUEST_ID_PATTERN.test(request.requestId))) {
            throw new AgentError('INVALID_ARGUMENT', 'A valid request ID is required.', 2);
        }

        const account = await this.db.get('account', this.plugin.NetworkClass.name) as WalletAccount | undefined;
        if (!account) {
            throw new AgentError('ACCOUNT_NOT_FOUND', `Wallet profile has no ${this.plugin.family} account.`, 3);
        }
        let stored: StoredSendRequest | undefined;
        try {
            if (request.dryRun) {
                const prepared = await this.prepare(account, request.to, amount, asset);
                try { return this.publicTransfer(prepared, 'dry-run'); }
                finally { Persist.clearSensitiveData(prepared); }
            }
            const requestId = request.requestId!;
            const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
                wallet: request.wallet,
                network: this.plugin.id,
                chainId: this.plugin.chainId ?? null,
                from: this.plugin.family === 'evm' ? account.address.toLowerCase() : account.address,
                to: this.plugin.family === 'evm' ? request.to.toLowerCase() : request.to,
                asset,
                amount
            })).digest('hex');
            stored = await this.db.get('sendRequest', requestId) ?? undefined;
            if (stored && stored.fingerprint !== fingerprint) {
                throw new AgentError('IDEMPOTENCY_CONFLICT', 'Request ID was already used with different transfer parameters.', 3);
            }
            if (stored) {
                if (stored.state === 'failed') throw this.failed(stored, requestId);
                if (stored.state === 'confirmed') return this.publicTransfer(stored, stored.state, requestId);
                if (stored.state !== 'prepared') {
                    const status = await this.transactionStatus(stored, requestId);
                    if (status.state !== 'not_found') {
                        stored.state = status.state;
                        await this.save(stored, requestId);
                        if (stored.state === 'failed') throw this.failed(stored, requestId);
                        return this.publicTransfer(stored, stored.state, requestId);
                    }
                    if (stored.state === 'submitted') {
                        throw new AgentError('BROADCAST_UNKNOWN', 'The previously submitted transaction is no longer reported by the provider.', 5,
                            { transactionHash: stored.transactionHash, requestId });
                    }
                }
            } else {
                if (this.plugin.id === 'bsc' || this.plugin.id === 'btc') await assertNoActiveSwap(this.db);
                const unresolved = (await this.list()).find(candidate =>
                    candidate.status === 'prepared' || candidate.status === 'broadcasting' || candidate.status === 'broadcast_unknown');
                if (unresolved) {
                    throw new AgentError('BROADCAST_UNKNOWN', 'Another transfer on this network has unresolved broadcast state.', 5,
                        { requestId: unresolved.requestId, transactionHash: unresolved.transactionHash });
                }
                const prepared = await this.prepare(account, request.to, amount, asset);
                const now = new Date().toISOString();
                stored = { ...prepared, fingerprint, state: 'prepared', network: this.plugin.id, createdAt: now, updatedAt: now };
                Persist.clearSensitiveData(prepared);
                await this.save(stored, requestId);
            }

            stored.state = 'broadcasting';
            await this.save(stored, requestId);
            let status: StoredSendRequest['state'];
            try {
                await this.network.sendSignedTransaction(stored.rawTransaction);
                status = this.plugin.family === 'bitcoin' ? 'submitted' : 'confirmed';
            } catch {
                try {
                    const observed = await this.network.getTransactionStatus(stored.transactionHash);
                    status = observed.state === 'not_found' ? 'broadcast_unknown' : observed.state;
                } catch { status = 'broadcast_unknown'; }
            }
            stored.state = status;
            await this.save(stored, requestId);
            if (status === 'failed') throw this.failed(stored, requestId);
            if (status === 'broadcast_unknown') {
                throw new AgentError('BROADCAST_UNKNOWN', 'The provider did not confirm whether the signed transaction was accepted.', 5,
                    { transactionHash: stored.transactionHash, requestId });
            }
            return this.publicTransfer(stored, status, requestId);
        } finally {
            Persist.clearSensitiveData(account);
            Persist.clearSensitiveData(stored);
        }
    }

    private async save(stored: StoredSendRequest, requestId: string): Promise<void> {
        stored.updatedAt = new Date().toISOString();
        await this.db.set('sendRequest', requestId, stored);
        await this.db.flush();
    }

    private failed(stored: StoredSendRequest, requestId: string): AgentError {
        return new AgentError('TRANSFER_FAILED', 'The transaction was mined but reverted.', 5,
            { transactionHash: stored.transactionHash, requestId });
    }

    private async transactionStatus(stored: StoredSendRequest, requestId: string): Promise<TransactionStatus> {
        try { return await this.network.getTransactionStatus(stored.transactionHash); }
        catch {
            throw new AgentError('NETWORK_ERROR', 'Unable to update the saved transaction status. Retry with the same request ID.', 4,
                { transactionHash: stored.transactionHash, requestId });
        }
    }

    private async prepare(account: WalletAccount, to: string, amount: string, asset: string): Promise<PreparedTransfer> {
        if (!this.network.validateAddress(to)) {
            throw new AgentError('INVALID_ARGUMENT', 'Invalid recipient address.', 2);
        }
        try { return await this.network.prepareTransfer(account, to, amount, asset); }
        catch (error) {
            if (error instanceof TypeError) throw new AgentError('INVALID_ARGUMENT', error.message, 2);
            throw new AgentError('TRANSFER_FAILED', (error as Error).message, 5);
        }
    }

    private publicTransfer(prepared: PreparedTransfer, status: TransferResult['status'], requestId?: string): TransferResult {
        return {
            ...(requestId ? { requestId } : {}),
            status,
            network: this.plugin.id,
            from: prepared.from,
            to: prepared.to,
            asset: prepared.asset,
            amount: prepared.amount,
            amountBaseUnits: prepared.amountBaseUnits,
            fee: prepared.fee,
            transactionHash: prepared.transactionHash
        };
    }
}
