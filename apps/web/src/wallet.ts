import { NetworkRegistry, clearSensitiveData, isNetworkUsageEntry, isRecordedTransfer, networkStorageName, recordNetworkUse, recordedTransferKeys,
    type AccountDetails, type Contact, type NetworkUsage, type RecordedTransfer, type WalletAccount, type AssetBalance } from 'hodl-wallet/browser';
import { webConfig } from '../config.mjs';
import { openHodlFile, sealHodlFile, type HodlFile } from './hodl-file.js';
import { BrowserVault, type VaultData } from './vault.js';
import { record } from './vault-crypto.js';
import { VaultError } from './vault-error.js';
import { networkRequest } from './network-access.js';
import { BrowserTransfers, type TransferInput, type TransferReview, type TransferOutcome, type HistoryEntry } from './transfers.js';

type Family = 'evm' | 'bitcoin';
type Metadata = { name: string; kind: 'mnemonic' | 'private-key'; createdAt: string };
/** The CLI's address book: network storage name, then address, then the contact. */
type Contacts = Record<string, Record<string, { name: string }>>;
/** The CLI's sent transfers: sender address, history key, id, then the transfer. */
type RecordedTransfers = Record<string, Record<string, Record<string, RecordedTransfer>>>;
type WalletData = VaultData & {
    metadata: Metadata; account: Record<string, WalletAccount>; mnemonic?: string; contact?: Contacts;
    transactions?: RecordedTransfers; sendRequest?: Record<string, unknown>; networkUsage?: NetworkUsage;
};
export type PublicWallet = {
    name: string;
    kind: Metadata['kind'];
    createdAt: string;
    accounts: Array<{ family: Family; address: string; networks: string[] }>;
    networks: Array<{ id: string; name: string; family: Family; nativeAsset: string; assets: string[] }>;
};
export type BalanceRow = { asset: string; balance?: AssetBalance; checkedAt?: string; error?: string };

function walletName(name: string): string {
    const normalized = name.trim();
    if (!normalized || normalized.length > webConfig.vault.nameMaxChars) throw new VaultError('Enter a valid wallet name.');
    return normalized;
}

function sameAddress(family: Family, a: string, b: string): boolean {
    return family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isContacts(value: unknown): value is Contacts {
    return record(value) && Object.values(value).every(book => record(book) && Object.values(book).every(entry =>
        record(entry) && typeof entry.name === 'string' && Object.keys(entry).length === 1));
}

/** The named entries of a CLI profile's address book. */
function profileContacts(value: unknown): Contacts {
    const contacts: Contacts = {};
    if (!record(value)) return contacts;
    for (const [network, book] of Object.entries(value)) {
        if (!record(book)) continue;
        for (const [address, entry] of Object.entries(book)) {
            if (record(entry) && typeof entry.name === 'string') (contacts[network] ??= {})[address] = { name: entry.name };
        }
    }
    return contacts;
}

function isRecordedTransfers(value: unknown): value is RecordedTransfers {
    return record(value) && Object.values(value).every(book => record(book) && Object.values(book).every(list =>
        record(list) && Object.values(list).every(isRecordedTransfer)));
}

/** Journal states whose broadcast needs no further decision. */
const SETTLED_STATES = ['submitted', 'confirmed', 'failed'];

function storedAccount(account: WalletAccount): WalletAccount {
    return { address: account.address, privateKey: account.privateKey,
        ...(account.publicKey ? { publicKey: account.publicKey } : {}) };
}

export class BrowserWallet {
    private readonly vault = new BrowserVault();
    private readonly registry = new NetworkRegistry();
    private readonly transfers = new BrowserTransfers(this.vault);
    private idleTimer?: ReturnType<typeof setTimeout>;
    private lastActivity = 0;
    private readonly balanceCache = new Map<string, BalanceRow[]>();

    constructor(private readonly onLock: () => void) {
        document.addEventListener('pointerdown', this.activity, { passive: true });
        document.addEventListener('keydown', this.activity);
        document.addEventListener('visibilitychange', this.checkIdle);
        window.addEventListener('pagehide', () => this.lock());
    }

    get unlocked(): boolean { return this.vault.unlocked; }
    exists(): Promise<boolean> { return this.vault.exists(); }

    private checkIdle = (): void => {
        if (this.unlocked && Date.now() - this.lastActivity >= webConfig.vault.idleMs) this.lock();
    };

    private activity = (): void => {
        if (!this.unlocked) return;
        if (this.lastActivity && Date.now() - this.lastActivity >= webConfig.vault.idleMs) { this.lock(); return; }
        this.lastActivity = Date.now();
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(this.checkIdle, webConfig.vault.idleMs);
    };

    lock(): void {
        this.vault.lock();
        this.transfers.reset();
        this.balanceCache.clear();
        clearTimeout(this.idleTimer);
        this.lastActivity = 0;
        this.onLock();
    }

    private network(family: Family) {
        const plugin = this.registry.firstForFamily(family);
        return { plugin, network: new plugin.NetworkClass(plugin) };
    }

    private async fromMnemonic(name: string, mnemonic: string): Promise<WalletData> {
        const evm = this.network('evm');
        const bitcoin = this.network('bitcoin');
        if (!evm.network.validateMnemonic(mnemonic)) throw new VaultError('Invalid recovery phrase. Check the words and their order.');
        let evmAccount: WalletAccount | undefined;
        let bitcoinAccount: WalletAccount | undefined;
        try {
            evmAccount = await evm.network.accountFromMnemonic(mnemonic);
            bitcoinAccount = await bitcoin.network.accountFromMnemonic(mnemonic);
            return {
                metadata: { name: walletName(name), kind: 'mnemonic', createdAt: new Date().toISOString() },
                account: { [evm.plugin.NetworkClass.name]: storedAccount(evmAccount), [bitcoin.plugin.NetworkClass.name]: storedAccount(bitcoinAccount) },
                mnemonic
            };
        } finally { clearSensitiveData(evmAccount); clearSensitiveData(bitcoinAccount); }
    }

    private async fromPrivateKey(name: string, family: Family, privateKey: string): Promise<WalletData> {
        if (family !== 'evm' && family !== 'bitcoin') throw new VaultError('Choose a valid network family.');
        const { network, plugin } = this.network(family);
        if (!network.validatePrivateKey(privateKey.trim())) throw new VaultError('The private key is invalid for the selected network.');
        const account = await network.privateKeyToAccount(privateKey.trim());
        try {
            return { metadata: { name: walletName(name), kind: 'private-key', createdAt: new Date().toISOString() },
                account: { [plugin.NetworkClass.name]: storedAccount(account) } };
        } finally { clearSensitiveData(account); }
    }

    /**
     * A CLI profile as a web wallet, which holds one recovery phrase for every network or one private key:
     * its phrase when every account derives from it, else its only account.
     */
    private async fromProfile(name: string, profile: unknown): Promise<WalletData> {
        if (!record(profile) || !record(profile.account)) throw new VaultError('The HODL file has no accounts.');
        const stored = profile.account;
        const accounts = (['evm', 'bitcoin'] as const).flatMap(family => {
            const account = stored[this.network(family).plugin.NetworkClass.name];
            return record(account) && typeof account.address === 'string' && typeof account.privateKey === 'string'
                ? [{ family, address: account.address, privateKey: account.privateKey }] : [];
        });
        if (!accounts.length) throw new VaultError('The HODL file has no accounts.');
        const mnemonic = profile.mnemonic;
        if (typeof mnemonic === 'string' && this.network('evm').network.validateMnemonic(mnemonic)) {
            const data = await this.fromMnemonic(name, mnemonic);
            if (accounts.every(({ family, address }) =>
                sameAddress(family, data.account[this.network(family).plugin.NetworkClass.name].address, address))) return data;
            clearSensitiveData(data);
        }
        if (accounts.length === 1) return this.fromPrivateKey(name, accounts[0].family, accounts[0].privateKey);
        throw new VaultError('The HODL file has separate keys per network. Import its recovery phrase or one private key instead.');
    }

    /**
     * The file's sent transfers from the wallet's accounts: recorded ones, and journal entries already broadcast.
     * Entries still awaiting a broadcast decision stay in the file.
     */
    private profileHistory(profile: unknown, accounts: WalletData['account']): Pick<WalletData, 'transactions' | 'sendRequest'> {
        const owners = (['evm', 'bitcoin'] as const).flatMap(family => {
            const account = accounts[this.network(family).plugin.NetworkClass.name];
            return account ? [{ family, address: account.address }] : [];
        });
        const owner = (address: unknown, family?: Family) => typeof address === 'string'
            ? owners.find(candidate => (family === undefined || candidate.family === family) && sameAddress(candidate.family, candidate.address, address))
            : undefined;
        const file = record(profile) ? profile : {};
        const transactions: RecordedTransfers = {};
        for (const [address, book] of Object.entries(record(file.transactions) ? file.transactions : {})) {
            const sender = owner(address);
            if (!sender || !record(book)) continue;
            for (const [key, list] of Object.entries(book)) {
                if (!record(list)) continue;
                for (const [id, transfer] of Object.entries(list)) {
                    if (isRecordedTransfer(transfer)) ((transactions[sender.address] ??= {})[key] ??= {})[id] = structuredClone(transfer);
                }
            }
        }
        const sendRequest: Record<string, unknown> = {};
        for (const [id, saved] of Object.entries(record(file.sendRequest) ? file.sendRequest : {})) {
            if (!record(saved)) continue;
            const plugin = this.registry.list().find(candidate => candidate.id === saved.network);
            if (plugin && owner(saved.from, plugin.family) && SETTLED_STATES.includes(String(saved.state)) &&
                typeof saved.transactionHash === 'string' && typeof saved.createdAt === 'string') sendRequest[id] = structuredClone(saved);
        }
        return { ...(Object.keys(transactions).length ? { transactions } : {}), ...(Object.keys(sendRequest).length ? { sendRequest } : {}) };
    }

    /** Saved transfers still waiting for the user's decision belong to the open wallet; replacing it would drop them. */
    private async assertReplaceable(): Promise<void> {
        for (const network of (await this.snapshot()).networks) {
            if ((await this.transfers.unresolved(network.id)).length) {
                throw new VaultError('Resolve the saved transfers in local activity before replacing this wallet.');
            }
        }
    }

    /** Replacing the open wallet with a phrase or a key keeps its address book and sent transfers, as the CLI does. */
    private keepingRecords(create: () => Promise<WalletData>): () => Promise<WalletData> {
        return async () => {
            const kept: Record<string, unknown> = {};
            for (const key of ['contact', 'transactions', 'sendRequest', 'networkUsage']) {
                const value = this.unlocked ? await this.vault.get(key) : undefined;
                if (value !== undefined) kept[key] = value;
            }
            return { ...await create(), ...kept };
        };
    }

    /** Creates the wallet with a new password, or replaces the open one keeping its password. */
    private async store(password: string | undefined, create: () => Promise<WalletData>): Promise<PublicWallet> {
        if (!this.unlocked) {
            if (password === undefined) throw new VaultError('Choose a password for the new wallet.');
            await this.vault.open(password, { validate: this.validate, create });
            return this.opened();
        }
        if (password !== undefined) throw new VaultError('A wallet is already open.');
        await this.assertReplaceable();
        await this.vault.replace(create, this.validate);
        return this.replaced();
    }

    private replaced(): Promise<PublicWallet> {
        this.transfers.reset();
        this.balanceCache.clear();
        return this.opened();
    }

    private validate = async (value: VaultData): Promise<void> => {
        if (Object.keys(value).some(key => !['metadata', 'account', 'mnemonic', 'contact', 'transactions', 'sendRequest', 'swapQuote', 'swapOperation', 'networkUsage'].includes(key)) ||
            !record(value.metadata) || !record(value.account) || (value.contact !== undefined && !isContacts(value.contact)) ||
            (value.transactions !== undefined && !isRecordedTransfers(value.transactions)) ||
            (value.networkUsage !== undefined && !(record(value.networkUsage) && Object.values(value.networkUsage).every(isNetworkUsageEntry)))) throw new VaultError('Invalid wallet data.');
        const metadata = value.metadata;
        if (typeof metadata.name !== 'string' || walletName(metadata.name) !== metadata.name ||
            !['mnemonic', 'private-key'].includes(String(metadata.kind)) ||
            typeof metadata.createdAt !== 'string' || !Number.isFinite(Date.parse(metadata.createdAt)) ||
            Object.keys(metadata).some(key => !['name', 'kind', 'createdAt'].includes(key))) {
            throw new VaultError('Invalid wallet data.');
        }
        const families = (['evm', 'bitcoin'] as const).map(family => ({ family, ...this.network(family) }));
        const entries = Object.entries(value.account);
        if (!entries.length || (metadata.kind === 'mnemonic' && entries.length !== families.length) ||
            (metadata.kind === 'private-key' && (entries.length !== 1 || value.mnemonic !== undefined))) {
            throw new VaultError('Invalid wallet accounts.');
        }
        if (metadata.kind === 'mnemonic' && (typeof value.mnemonic !== 'string' || !families[0].network.validateMnemonic(value.mnemonic))) {
            throw new VaultError('Invalid wallet recovery phrase.');
        }
        for (const [key, account] of entries) {
            const family = families.find(entry => entry.plugin.NetworkClass.name === key);
            if (!family || !record(account) || typeof account.privateKey !== 'string' || typeof account.address !== 'string' ||
                Object.keys(account).some(field => !['privateKey', 'address', 'publicKey'].includes(field)) ||
                !family.network.validatePrivateKey(account.privateKey)) throw new VaultError('An account in the wallet is invalid.');
            let derived: WalletAccount | undefined;
            let fromPhrase: WalletAccount | undefined;
            try {
                derived = await family.network.privateKeyToAccount(account.privateKey);
                const equalAddress = (address: string) => sameAddress(family.family, address, account.address as string);
                if (!equalAddress(derived.address) || (account.publicKey !== undefined && account.publicKey !== derived.publicKey)) {
                    throw new VaultError('An address in the wallet does not match its account.');
                }
                if (typeof value.mnemonic === 'string') {
                    fromPhrase = await family.network.accountFromMnemonic(value.mnemonic);
                    if (!equalAddress(fromPhrase.address)) throw new VaultError('The wallet recovery phrase does not match its accounts.');
                }
            } finally { clearSensitiveData(derived); clearSensitiveData(fromPhrase); }
        }
    };

    private async opened(): Promise<PublicWallet> {
        this.lastActivity = 0;
        this.activity();
        return this.snapshot();
    }

    async create(name: string, password: string, words: 12 | 24): Promise<PublicWallet> {
        walletName(name);
        if (words !== 12 && words !== 24) throw new VaultError('Choose a 12- or 24-word phrase.');
        await this.vault.open(password, { validate: this.validate, create: async () => {
            const account = await this.network('evm').network.createAccountFromMnemonic(words);
            try {
                if (!account.mnemonic) throw new VaultError('Could not create the recovery phrase.');
                return await this.fromMnemonic(name, account.mnemonic);
            } finally { clearSensitiveData(account); }
        } });
        return this.opened();
    }

    /** Without a password it replaces the open wallet; the same holds for the other imports. */
    importMnemonic(name: string, password: string | undefined, phrase: string): Promise<PublicWallet> {
        const mnemonic = phrase.trim().toLowerCase().split(/\s+/).join(' ');
        return this.store(password, this.keepingRecords(() => this.fromMnemonic(name, mnemonic)));
    }

    importPrivateKey(name: string, password: string | undefined, family: Family, privateKey: string): Promise<PublicWallet> {
        return this.store(password, this.keepingRecords(() => this.fromPrivateKey(name, family, privateKey)));
    }

    importHodlFile(name: string, password: string | undefined, file: HodlFile, filePassword: string): Promise<PublicWallet> {
        return this.store(password, async () => {
            const profile = await openHodlFile(file, filePassword);
            try {
                const data = await this.fromProfile(name, profile);
                const contact = profileContacts(record(profile) ? profile.contact : undefined);
                return { ...data, ...(Object.keys(contact).length ? { contact } : {}), ...this.profileHistory(profile, data.account) };
            }
            finally { clearSensitiveData(profile); }
        });
    }

    async unlock(password: string): Promise<PublicWallet> {
        await this.vault.open(password, { validate: this.validate });
        return this.opened();
    }

    /** The wallet's accounts, address book and sent transfers as the CLI profile inside a .HODL file, sealed with the wallet password. */
    async exportHodlFile(password: string): Promise<string> {
        await this.vault.verifyPassword(password);
        const { store } = this.vault.scope();
        const profile: Record<string, unknown> = { account: await store.get('account') };
        for (const key of ['mnemonic', 'contact', 'transactions', 'sendRequest']) {
            const value = await store.get(key);
            if (value !== undefined) profile[key] = value;
        }
        try { return await sealHodlFile(profile, password); }
        finally { clearSensitiveData(profile); }
    }

    previewTransfer(network: string, to: string, asset: string) { return this.transfers.preview(network, to, asset); }
    unresolvedTransfers(network: string) { return this.transfers.unresolved(network); }
    estimateTransfer(input: TransferInput): Promise<TransferReview> { return this.transfers.estimate(input); }
    reviewSavedTransfer(network: string, id: string): Promise<TransferReview> { return this.transfers.reviewSaved(network, id); }
    confirmTransfer(id: string, onBroadcast: () => void): Promise<TransferOutcome> { return this.transfers.confirm(id, onBroadcast); }
    transferHistory(refresh: boolean, networkId?: string): Promise<HistoryEntry[]> { return this.transfers.history(refresh, networkId); }

    /** Transfers the CLI recorded from `address` on a network, outside the journal. */
    async recordedTransfers(networkId: string, address: string): Promise<RecordedTransfer[]> {
        const { store } = this.vault.scope();
        const recorded: RecordedTransfer[] = [];
        for (const key of recordedTransferKeys(this.registry.get(networkId))) {
            recorded.push(...(await store.entries('transactions', address, key) as Array<[string, RecordedTransfer]>).map(([, transfer]) => transfer));
        }
        return recorded;
    }
    cancelTransferReview(): void { this.transfers.reset(); }

    private contactBook(networkId: string): string {
        return networkStorageName(this.registry.get(networkId));
    }

    async contacts(networkId: string): Promise<Contact[]> {
        const { store } = this.vault.scope();
        const entries = await store.entries('contact', this.contactBook(networkId)) as Array<[string, { name: string }]>;
        return entries.map(([address, { name }]) => ({ address, name }));
    }

    async contactName(networkId: string, address: string): Promise<string | undefined> {
        const { store } = this.vault.scope();
        const name = await store.get('contact', this.contactBook(networkId), address, 'name');
        return typeof name === 'string' ? name : undefined;
    }

    async saveContact(networkId: string, address: string, name: string): Promise<void> {
        const { store } = this.vault.scope();
        await store.set('contact', this.contactBook(networkId), address, { name });
        await store.flush();
    }

    async deleteContact(networkId: string, address: string): Promise<void> {
        const { store } = this.vault.scope();
        const book = this.contactBook(networkId);
        const contacts = await store.get('contact', book) as Contacts[string] | undefined;
        if (!contacts || !Object.hasOwn(contacts, address)) return;
        delete contacts[address];
        await store.set('contact', book, contacts);
        await store.flush();
    }

    async clearContacts(): Promise<void> {
        const { store } = this.vault.scope();
        await store.set('contact', {});
        await store.flush();
    }

    async networkUsage(): Promise<NetworkUsage> {
        const { store } = this.vault.scope();
        return (await store.get('networkUsage') ?? {}) as NetworkUsage;
    }

    /** Counts a use of the network, as the CLI does. */
    async useNetwork(networkId: string): Promise<NetworkUsage> {
        const { store } = this.vault.scope();
        const usage = (await store.get('networkUsage') ?? {}) as NetworkUsage;
        recordNetworkUse(usage, this.registry.get(networkId));
        await store.set('networkUsage', usage);
        await store.flush();
        return usage;
    }

    async balances(networkId: string): Promise<BalanceRow[]> {
        const { store, check } = this.vault.scope();
        const plugin = this.registry.get(networkId);
        const address = await store.get('account', plugin.NetworkClass.name, 'address');
        if (typeof address !== 'string') throw new VaultError('This wallet has no account for the selected network.');
        const network = new plugin.NetworkClass(plugin);
        const previous = this.balanceCache.get(networkId) ?? [];
        const rows = await Promise.all([plugin.nativeToken, ...Object.keys(plugin.tokens)].map(async asset => {
            try {
                const balance = await networkRequest(() => network.getAssetBalance(address, asset), check);
                return { asset, balance, checkedAt: new Date().toISOString() };
            } catch {
                check();
                return { ...previous.find(row => row.asset === asset), asset,
                    error: 'Balance unavailable. Check your connection or try again.' };
            }
        }));
        check();
        this.balanceCache.set(networkId, rows);
        return structuredClone(rows);
    }

    async address(networkId: string): Promise<string | undefined> {
        const { store } = this.vault.scope();
        const address = await store.get('account', this.registry.get(networkId).NetworkClass.name, 'address');
        return typeof address === 'string' ? address : undefined;
    }

    /** A detached copy of the selected network's account. The caller clears it. */
    async accountDetails(networkId: string): Promise<AccountDetails | null> {
        const { store } = this.vault.scope();
        const account = await store.get('account', this.registry.get(networkId).NetworkClass.name) as WalletAccount | undefined;
        if (!account) return null;
        const mnemonic = await store.get('mnemonic');
        const details = { address: account.address, privateKey: account.privateKey, ...(typeof mnemonic === 'string' ? { mnemonic } : {}) };
        clearSensitiveData(account);
        return details;
    }

    async snapshot(): Promise<PublicWallet> {
        const metadata = await this.vault.get('metadata') as Metadata;
        const accounts = await this.vault.get('account') as Record<string, WalletAccount>;
        try {
            if (!this.unlocked) throw new VaultError('The wallet is locked.');
            return { ...metadata,
                networks: this.registry.list().filter(plugin => accounts[plugin.NetworkClass.name]).map(plugin => ({
                    id: plugin.id, name: plugin.name.replace(/^\[[^\]]+\]\s*/, ''), family: plugin.family,
                    nativeAsset: plugin.nativeToken, assets: [plugin.nativeToken, ...Object.keys(plugin.tokens)]
                })),
                accounts: (['evm', 'bitcoin'] as const).flatMap(family => {
                const plugin = this.registry.firstForFamily(family);
                const account = accounts[plugin.NetworkClass.name];
                return account ? [{ family, address: account.address,
                    networks: this.registry.list().filter(network => network.family === family).map(network => network.name.replace(/^\[[^\]]+\]\s*/, '')) }] : [];
            }) };
        } finally { clearSensitiveData(accounts); }
    }
}
