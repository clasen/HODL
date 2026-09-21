import { NetworkRegistry, clearSensitiveData, type WalletAccount, type AssetBalance } from 'hodl-wallet/browser';
import { webConfig } from '../config.mjs';
import { BrowserVault, type VaultData } from './vault.js';
import { parseBackup, record } from './vault-crypto.js';
import { VaultError } from './vault-error.js';
import { networkRequest } from './network-access.js';
import { BrowserTransfers, type TransferInput, type TransferReview, type TransferOutcome, type HistoryEntry } from './transfers.js';

type Family = 'evm' | 'bitcoin';
type Metadata = { name: string; kind: 'mnemonic' | 'private-key'; createdAt: string };
type WalletData = VaultData & { metadata: Metadata; account: Record<string, WalletAccount>; mnemonic?: string };
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

    private validate = async (value: VaultData): Promise<void> => {
        if (Object.keys(value).some(key => !['metadata', 'account', 'mnemonic', 'sendRequest', 'swapQuote', 'swapOperation'].includes(key)) ||
            !record(value.metadata) || !record(value.account)) throw new VaultError('Invalid wallet data.');
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
            throw new VaultError('Invalid backup accounts.');
        }
        if (metadata.kind === 'mnemonic' && (typeof value.mnemonic !== 'string' || !families[0].network.validateMnemonic(value.mnemonic))) {
            throw new VaultError('Invalid backup recovery phrase.');
        }
        for (const [key, account] of entries) {
            const family = families.find(entry => entry.plugin.NetworkClass.name === key);
            if (!family || !record(account) || typeof account.privateKey !== 'string' || typeof account.address !== 'string' ||
                Object.keys(account).some(field => !['privateKey', 'address', 'publicKey'].includes(field)) ||
                !family.network.validatePrivateKey(account.privateKey)) throw new VaultError('An account in the backup is invalid.');
            let derived: WalletAccount | undefined;
            let fromPhrase: WalletAccount | undefined;
            try {
                derived = await family.network.privateKeyToAccount(account.privateKey);
                const equalAddress = (address: string) => family.family === 'evm'
                    ? address.toLowerCase() === (account.address as string).toLowerCase() : address === account.address;
                if (!equalAddress(derived.address) || (account.publicKey !== undefined && account.publicKey !== derived.publicKey)) {
                    throw new VaultError('An address in the backup does not match its account.');
                }
                if (typeof value.mnemonic === 'string') {
                    fromPhrase = await family.network.accountFromMnemonic(value.mnemonic);
                    if (!equalAddress(fromPhrase.address)) throw new VaultError('The backup recovery phrase does not match its accounts.');
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

    async importMnemonic(name: string, password: string, phrase: string): Promise<PublicWallet> {
        const mnemonic = phrase.trim().toLowerCase().split(/\s+/).join(' ');
        await this.vault.open(password, { validate: this.validate, create: () => this.fromMnemonic(name, mnemonic) });
        return this.opened();
    }

    async importPrivateKey(name: string, password: string, family: Family, privateKey: string): Promise<PublicWallet> {
        if (family !== 'evm' && family !== 'bitcoin') throw new VaultError('Choose a valid network family.');
        await this.vault.open(password, { validate: this.validate, create: async () => {
            const { network, plugin } = this.network(family);
            if (!network.validatePrivateKey(privateKey.trim())) throw new VaultError('The private key is invalid for the selected network.');
            const account = await network.privateKeyToAccount(privateKey.trim());
            try {
                return { metadata: { name: walletName(name), kind: 'private-key', createdAt: new Date().toISOString() },
                    account: { [plugin.NetworkClass.name]: storedAccount(account) } };
            } finally { clearSensitiveData(account); }
        } });
        return this.opened();
    }

    async unlock(password: string): Promise<PublicWallet> {
        await this.vault.open(password, { validate: this.validate });
        return this.opened();
    }

    async restore(text: string, password: string): Promise<PublicWallet> {
        await this.vault.open(password, { backup: parseBackup(text), validate: this.validate });
        return this.opened();
    }

    exportBackup(): Promise<string> { return this.vault.exportBackup(); }

    estimateTransfer(input: TransferInput): Promise<TransferReview> { return this.transfers.estimate(input); }
    reviewSavedTransfer(network: string, id: string): Promise<TransferReview> { return this.transfers.reviewSaved(network, id); }
    confirmTransfer(id: string, onBroadcast: () => void): Promise<TransferOutcome> { return this.transfers.confirm(id, onBroadcast); }
    transferHistory(refresh: boolean): Promise<HistoryEntry[]> { return this.transfers.history(refresh); }
    cancelTransferReview(): void { this.transfers.reset(); }

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
