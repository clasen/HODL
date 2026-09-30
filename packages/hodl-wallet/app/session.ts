import type { BaseNetworkContract, NetworkPlugin } from '../network/types.js';
import type { TransferResult } from '../transfer-service.js';
import type { Cell, Ui } from './ui.js';

export interface AccountDetails {
    address: string;
    privateKey: string;
    mnemonic?: string;
}

export interface Contact {
    address: string;
    name: string;
}

export interface SentTransfer {
    timestamp: string | number | Date;
    recipient: string;
    contact?: string;
    token: string;
    amount: string | number;
    balance?: string | number;
    status?: string;
    url: string;
}

export interface TransferDraft {
    to: string;
    asset: string;
    /** A decimal amount, or `max`. */
    amount: string;
}

export interface PendingTransfer {
    requestId: string;
    to: string;
    asset: string;
    amount: string;
    status: string;
}

export interface TransferPort {
    pending(): Promise<PendingTransfer[]>;
    /** What `max` would send and the fee it would pay. Sends nothing. */
    preview(draft: { to: string; asset: string }): Promise<{ amount: string; fee: { amount: string; asset: string } }>;
    /**
     * Optional. Prepares the transfer and returns what the user must see before it is signed.
     * A resumed transfer is reviewed as saved. When present, `send` must send exactly what was reviewed.
     */
    review?(draft: TransferDraft, resume?: string): Promise<Cell[][]>;
    send(draft: TransferDraft, requestId: string): Promise<TransferResult>;
    /** Stores whatever the host keeps about a sent transfer and describes it for display. */
    record(result: TransferResult, draft: TransferDraft): Promise<SentTransfer>;
}

/** Optional address book. Absent hosts show no contact columns or prompts. */
export interface ContactsPort {
    list(): Promise<Contact[]>;
    get(address: string): Promise<string | undefined>;
    set(address: string, name: string): Promise<void>;
    delete(address: string): Promise<void>;
    clear(): Promise<void>;
}

/** A menu entry only some hosts have, such as swaps or file import. */
export interface HostAction {
    name: string;
    /** Import actions return true when they replaced the account. */
    run(ui: Ui): Promise<boolean | void>;
}

export interface SessionCapabilities {
    /** Create or import over the current account from Account Settings. */
    replaceAccount: boolean;
    /** Sent-transfer rows carry the balance after sending. */
    balanceHistory: boolean;
    /** The first-run account menu offers Switch Network. */
    switchNetworkFirst: boolean;
    /** Amounts are shown as the network reports them instead of rounded for reading. */
    exactAmounts: boolean;
}

export type NewAccount = 'existing-mnemonic' | 'random' | 12 | 24;

/** What the shared flows need from an unlocked wallet. Nothing here prompts. */
export interface WalletSession {
    readonly capabilities: SessionCapabilities;
    readonly plugin: NetworkPlugin;
    /** The selected network. Flows use it only to validate input. Read it again after selectNetwork. */
    readonly network: BaseNetworkContract;
    readonly transfers: TransferPort;
    readonly contacts?: ContactsPort;

    start(): Promise<void>;
    networks(): NetworkPlugin[];
    selectNetwork(plugin: NetworkPlugin): Promise<void>;
    hasAccount(): Promise<boolean>;
    address(): Promise<string>;
    hasMnemonic(): Promise<boolean>;
    createAccount(kind: NewAccount): Promise<void>;
    importMnemonic(mnemonic: string): Promise<void>;
    importPrivateKey(privateKey: string): Promise<void>;
    /** A detached copy. The caller clears it. */
    accountDetails(): Promise<AccountDetails | null>;
    tokenBalances(): Promise<Array<[string, string]>>;
    sentTransfers(): Promise<SentTransfer[]>;
    importActions(): HostAction[];
    exportActions(): HostAction[];
    menuActions(): HostAction[];
}
