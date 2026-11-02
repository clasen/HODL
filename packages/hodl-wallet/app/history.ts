import { walletConfig } from '../config.js';
import type { ChainTransfer, NetworkPlugin, TransferScan } from '../network/types.js';
import type { TransferResult } from '../transfer-service.js';
import { errorMessage } from './format.js';
import type { TransferRow, SentTransfer } from './session.js';
import { isPromptAborted } from './ui.js';

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

/** What a host saves of one address's transfers on a network: what scans found, and where the next scan starts. */
export type TransferSnapshot = {
    cursor?: string;
    transfers: ChainTransfer[];
};

function isChainTransfer(value: unknown): value is ChainTransfer {
    return isRecord(value) && ['id', 'hash', 'counterparty', 'asset', 'amount'].every(field => typeof value[field] === 'string') &&
        ['in', 'out'].includes(value.direction as string) && ['pending', 'confirmed'].includes(value.state as string) &&
        (value.timestamp === undefined || typeof value.timestamp === 'string');
}

export function isTransferSnapshot(value: unknown): value is TransferSnapshot {
    return isRecord(value) && (value.cursor === undefined || typeof value.cursor === 'string') &&
        Array.isArray(value.transfers) && value.transfers.every(isChainTransfer);
}

const newestFirst = (a: ChainTransfer, b: ChainTransfer) => (b.timestamp ?? '\uffff').localeCompare(a.timestamp ?? '\uffff');

/** The snapshot with a scan added. Unconfirmed transfers stay only while scans still report them; the newest are kept. */
export function mergeTransferScan(saved: TransferSnapshot | undefined, scan: TransferScan): TransferSnapshot {
    const transfers = new Map((saved?.transfers ?? []).filter(tx => tx.state === 'confirmed').map(tx => [tx.id, tx]));
    for (const tx of scan.transfers) transfers.set(tx.id, tx);
    const cursor = scan.cursor ?? saved?.cursor;
    return {
        ...(cursor !== undefined ? { cursor } : {}),
        transfers: [...transfers.values()].sort(newestFirst).slice(0, walletConfig.history.keptTransfers)
    };
}

/** Scans from where the saved snapshot left off. A failed scan leaves the snapshot as saved and says why. */
export async function rescanTransfers(
    saved: TransferSnapshot | undefined,
    scan: (cursor: string | undefined) => Promise<TransferScan>
): Promise<{ snapshot: TransferSnapshot | undefined; error?: string }> {
    try {
        return { snapshot: mergeTransferScan(saved, await scan(saved?.cursor)) };
    } catch (error) {
        if (isPromptAborted(error)) throw error;
        return { snapshot: saved, error: errorMessage(error) };
    }
}

/** Recent transfers as listed by the network, newest first, with the other party's contact name. */
export function recentTransferRows(
    plugin: NetworkPlugin,
    transfers: ChainTransfer[],
    contactName: (address: string) => Promise<string | undefined>
): Promise<TransferRow[]> {
    return Promise.all(transfers.map(async tx => ({
        ...(tx.timestamp ? { timestamp: tx.timestamp } : {}),
        direction: tx.direction === 'in' ? 'In' as const : 'Out' as const,
        counterparty: tx.counterparty, contact: await contactName(tx.counterparty),
        token: tx.asset, amount: tx.amount, status: tx.state,
        url: plugin.explorer + tx.hash
    })));
}

/** The part of an address after its format prefix, which an imitation copies. */
function addressBody(address: string): string {
    return address.toLowerCase().replace(/^(0x|bc1.|tb1.|[123mn])/, '');
}

/** Whether the address starts or ends like a known one without being it, as address poisoning does. */
function imitates(address: string, known: string[]): boolean {
    const chars = walletConfig.history.lookAlikeChars;
    const body = addressBody(address);
    return known.map(addressBody).some(other => other !== body &&
        (other.slice(0, chars) === body.slice(0, chars) || other.slice(-chars) === body.slice(-chars)));
}

/**
 * Sent transfers and the network's recent ones as one list, oldest first and unconfirmed last.
 * A sent transfer stands for the network's outgoing rows of the same transaction. The network's
 * transfers worth nothing (anyone can move zero on another's behalf) and incoming ones from an
 * address imitating one paid or known (`known`: the wallet's own and its contacts) are left out as
 * likely address poisoning and only counted.
 */
export function transferRows(sent: SentTransfer[], recent: TransferRow[], known: string[]): { rows: TransferRow[]; hidden: number } {
    const sentUrls = new Set(sent.map(tx => tx.url));
    const valued = recent.filter(tx => Number(tx.amount) > 0);
    const outgoing = valued.filter(tx => tx.direction === 'Out');
    const paid = [...known, ...sent.map(tx => tx.recipient), ...outgoing.map(tx => tx.counterparty)];
    const incoming = valued.filter(tx => tx.direction === 'In' && !imitates(tx.counterparty, paid));
    const rows: TransferRow[] = [
        ...sent.map(({ recipient, ...tx }) => ({ ...tx, direction: 'Out' as const, counterparty: recipient })),
        ...outgoing.filter(tx => !sentUrls.has(tx.url)),
        ...incoming
    ];
    const time = (row: TransferRow) => row.timestamp === undefined ? Infinity : new Date(row.timestamp).getTime();
    return {
        rows: rows.sort((a, b) => time(a) === time(b) ? 0 : time(a) < time(b) ? -1 : 1),
        hidden: recent.length - outgoing.length - incoming.length
    };
}
