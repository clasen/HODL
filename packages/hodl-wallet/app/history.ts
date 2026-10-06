import type { NetworkPlugin } from '../network/types.js';
import type { TransferResult } from '../transfer-service.js';
import type { SentTransfer } from './session.js';

/** A sent transfer recorded under `transactions`, then the sender's address, a history key and an id. */
export type RecordedTransfer = {
    timestamp: string;
    recipient: string;
    token: string;
    amount: string | number;
    hash: string;
    balance?: string | number;
    status?: string;
};

/** A transfer from the durable journal (`sendRequest`). */
export type JournalTransfer = TransferResult & { createdAt: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRecordedTransfer(value: unknown): value is RecordedTransfer {
    return isRecord(value) && ['timestamp', 'recipient', 'token', 'hash'].every(field => typeof value[field] === 'string') &&
        ['string', 'number'].includes(typeof value.amount) &&
        (value.balance === undefined || ['string', 'number'].includes(typeof value.balance)) &&
        (value.status === undefined || typeof value.status === 'string');
}

/** The history keys holding a network's recorded transfers: its native token, plus the symbol older versions used for Optimism and Arbitrum. */
export function recordedTransferKeys(plugin: NetworkPlugin): string[] {
    const legacy = ({ op: 'OP', arb: 'ARB' } as Record<string, string | undefined>)[plugin.id];
    return legacy ? [plugin.nativeToken, legacy] : [plugin.nativeToken];
}

/** Transfers sent from `address`, oldest first: the recorded ones and the journal's, whose status wins for the same hash. */
export async function sentTransfers(
    plugin: NetworkPlugin,
    address: string,
    recorded: RecordedTransfer[],
    journal: JournalTransfer[],
    contactName: (address: string) => Promise<string | undefined>
): Promise<SentTransfer[]> {
    const history = recorded.map(transfer => ({ ...transfer }));
    for (const transfer of journal.filter(item => item.from === address)) {
        const existing = history.find(item => item.hash === transfer.transactionHash);
        if (existing) existing.status = transfer.status;
        else history.push({
            timestamp: transfer.createdAt, recipient: transfer.to, token: transfer.asset,
            amount: transfer.amount, hash: transfer.transactionHash, status: transfer.status
        });
    }
    history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return Promise.all(history.map(async tx => ({
        timestamp: tx.timestamp, recipient: tx.recipient, contact: await contactName(tx.recipient),
        token: tx.token, amount: tx.amount, balance: tx.balance, status: tx.status,
        url: plugin.explorer + tx.hash
    })));
}
