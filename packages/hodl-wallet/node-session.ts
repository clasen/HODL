import fs from 'fs';
import os from 'os';
import path from 'path';
import Persist from './persist.js';
import { TransferService } from './transfer-service.js';
import type { TransferResult } from './transfer-service.js';
import { NetworkRegistry, networkStorageName } from './network-registry.js';
import { ProfileLock } from './profile-lock.js';
import { SwapService } from './swap/service.js';
import { routeForNetwork } from './swap/routes.js';
import { startSwapMenu } from './swap/ui.js';
import { errorMessage } from './app/format.js';
import { showError } from './app/output.js';
import type {
    AccountDetails, Contact, ContactsPort, HostAction, NewAccount, PendingTransfer, SentTransfer,
    SessionCapabilities, TransferDraft, TransferPort, WalletSession
} from './app/session.js';
import type { Ui } from './app/ui.js';
import type {
    BaseNetworkContract,
    NetworkPlugin,
    NetworkUsage,
    NetworkUsageEntry,
    WalletAccount
} from './network/types.js';

type StoredContact = {
    name: string;
};
type StoredTransaction = {
    timestamp: string;
    recipient: string;
    token: string;
    amount: string | number;
    hash: string;
    balance?: string | number;
    status?: string;
};

function isNetworkUsageEntry(value: unknown): value is NetworkUsageEntry {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        typeof (value as Partial<NetworkUsageEntry>).count === 'number'
    );
}

async function askEncryptionKey(ui: Ui): Promise<string> {
    return ui.password({ message: 'Password:' });
}

/** The encrypted profile in ~/.HODL as a wallet session. Prompts only through the Ui it is given. */
export class NodeSession implements WalletSession {
    readonly capabilities: SessionCapabilities = { replaceAccount: true, balanceHistory: true, switchNetworkFirst: false, exactAmounts: false };
    readonly transfers: TransferPort;
    readonly contacts: ContactsPort;

    private db: Persist;
    private selectedNetwork: NetworkPlugin;
    private networkInstance: BaseNetworkContract;
    private networkUsage: NetworkUsage;
    private readonly databaseExisted: boolean;
    private readonly profileLock: ProfileLock;
    private readonly hodlDir: string;

    constructor(encryptionKey: string, profileLock: ProfileLock) {
        const hodlDir = path.join(os.homedir(), '.HODL');
        this.hodlDir = hodlDir;

        if (!fs.existsSync(hodlDir)) {
            fs.mkdirSync(hodlDir, { recursive: true, mode: 0o700 });
        }
        fs.chmodSync(hodlDir, 0o700);

        this.databaseExisted = fs.existsSync(path.join(hodlDir, 'persist.json'));
        this.profileLock = profileLock;
        try {
            this.db = new Persist({ path: hodlDir, encryptionKey });
        } catch (error) {
            this.profileLock.release();
            throw error;
        }

        this.networkInstance = null as unknown as BaseNetworkContract;
        this.selectedNetwork = null as unknown as NetworkPlugin;
        this.networkUsage = {};
        this.transfers = this.transferPort();
        this.contacts = this.contactsPort();
    }

    get plugin(): NetworkPlugin { return this.selectedNetwork; }
    get network(): BaseNetworkContract { return this.networkInstance; }

    async connect(): Promise<void> {
        await this.db.connect();
        this.securePersistFile();
    }

    hasStoredDatabase(): boolean {
        return this.databaseExisted;
    }

    async start(): Promise<void> {
        const rawNetworkUsage = await this.db.get('networkUsage') || {};

        // Validate and clean networkUsage data
        this.networkUsage = {};
        for (const [networkName, usage] of Object.entries(rawNetworkUsage)) {
            if (typeof usage === 'number') {
                // Old format - convert to new format
                this.networkUsage[networkName] = {
                    count: usage,
                    lastUsed: 0
                };
            } else if (isNetworkUsageEntry(usage)) {
                // Valid new format
                this.networkUsage[networkName] = {
                    count: usage.count,
                    lastUsed: usage.lastUsed || 0
                };
            }
            // Skip corrupted entries (they'll be recreated when needed)
        }

        const networkPlugins = this.networks();
        if (networkPlugins.length === 0) {
            throw new Error('No valid network plugins found.');
        }
        // The most recently used network
        await this.selectNetwork(networkPlugins[0]);
    }

    /** Most recently used first. */
    networks(): NetworkPlugin[] {
        return new NetworkRegistry().list().sort((a, b) => {
            const aUsage = this.networkUsage[networkStorageName(a)];
            const bUsage = this.networkUsage[networkStorageName(b)];

            // Handle old format (number) vs new format (object)
            const aLastUsed = typeof aUsage === 'object' ? aUsage.lastUsed || 0 : 0;
            const bLastUsed = typeof bUsage === 'object' ? bUsage.lastUsed || 0 : 0;

            // If neither has lastUsed timestamp, sort by old count format
            if (aLastUsed === 0 && bLastUsed === 0) {
                const aCount = typeof aUsage === 'number' ? aUsage : (aUsage?.count || 0);
                const bCount = typeof bUsage === 'number' ? bUsage : (bUsage?.count || 0);
                return bCount - aCount;
            }

            return bLastUsed - aLastUsed;
        });
    }

    async selectNetwork(selectedNetwork: NetworkPlugin): Promise<void> {
        // Update usage info for the selected network
        // Handle migration from old format (number) to new format (object)
        const currentUsage = this.networkUsage[networkStorageName(selectedNetwork)];

        if (!currentUsage || typeof currentUsage === 'number' || typeof currentUsage !== 'object' || currentUsage === null || Array.isArray(currentUsage)) {
            // Old format (number), doesn't exist, or corrupted data - create new object
            this.networkUsage[networkStorageName(selectedNetwork)] = {
                count: typeof currentUsage === 'number' ? currentUsage + 1 : 1,
                lastUsed: Date.now()
            };
        } else if (isNetworkUsageEntry(currentUsage)) {
            // New format (object) - update values
            currentUsage.count = (currentUsage.count || 0) + 1;
            currentUsage.lastUsed = Date.now();
        } else {
            this.networkUsage[networkStorageName(selectedNetwork)] = {
                count: 1,
                lastUsed: Date.now()
            };
        }

        await this.db.set('networkUsage', this.networkUsage);

        this.selectedNetwork = selectedNetwork;
        this.networkInstance = new selectedNetwork.NetworkClass(selectedNetwork);
        this.networkInstance.name = selectedNetwork.name;
    }

    private async setAccount(account: WalletAccount | null): Promise<void> {
        if (!account) {
            return;
        }

        await this.db.set('account', this.network.constructor.name, account);
        if (account.mnemonic) {
            await this.db.set('mnemonic', account.mnemonic);
        }
    }

    private async getAccount(): Promise<WalletAccount | null> {
        const account = await this.db.get('account', this.network.constructor.name);

        return account ?? null;
    }

    async address(): Promise<string> {
        return this.db.get('account', this.network.constructor.name, 'address');
    }

    private async getMnemonic(): Promise<string | null> {
        return await this.db.get('mnemonic') ?? null;
    }

    async hasMnemonic(): Promise<boolean> {
        return Boolean(await this.getMnemonic());
    }

    async hasAccount(): Promise<boolean> {
        return typeof await this.db.get(
            'account',
            this.network.constructor.name,
            'address'
        ) === 'string';
    }

    async createAccount(kind: NewAccount): Promise<void> {
        if (kind === 'existing-mnemonic') {
            await this.setAccount(await this.network.accountFromMnemonic((await this.getMnemonic())!));
        } else if (kind === 'random') {
            await this.setAccount(await this.network.createAccount());
        } else {
            await this.setAccount(await this.network.createAccountFromMnemonic(kind));
        }
    }

    async importMnemonic(mnemonic: string): Promise<void> {
        const account = await this.network.accountFromMnemonic(mnemonic);
        await this.setAccount(account);
        Persist.clearSensitiveData(account);
    }

    async importPrivateKey(privateKey: string): Promise<void> {
        await this.setAccount(await this.network.privateKeyToAccount(privateKey));
    }

    async accountDetails(): Promise<AccountDetails | null> {
        const account = await this.getAccount();
        if (!account) return null;
        const mnemonic = await this.getMnemonic();
        const details = {
            address: await this.address(),
            privateKey: account.privateKey,
            ...(mnemonic ? { mnemonic } : {})
        };
        Persist.clearSensitiveData(account);
        return details;
    }

    async tokenBalances(): Promise<Array<[string, string]>> {
        return this.network.getTokenBalances(await this.address());
    }

    async sentTransfers(): Promise<SentTransfer[]> {
        const address = await this.address();
        const history = await this.db.values(
            'transactions',
            address,
            this.selectedNetwork.nativeToken
        ) as StoredTransaction[] || [];
        const legacyHistoryKey = this.selectedNetwork.id === 'op'
            ? 'OP'
            : this.selectedNetwork.id === 'arb'
                ? 'ARB'
                : null;
        if (legacyHistoryKey) {
            const legacyHistory = await this.db.values(
                'transactions',
                address,
                legacyHistoryKey
            ) as StoredTransaction[] || [];
            history.push(...legacyHistory);
            history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        }

        const transfers = await this.transferService().list();
        for (const transfer of transfers.filter(item => item.from === address)) {
            const existing = history.find(item => item.hash === transfer.transactionHash);
            if (existing) existing.status = transfer.status;
            else history.push({
                timestamp: transfer.createdAt, recipient: transfer.to, token: transfer.asset,
                amount: transfer.amount, hash: transfer.transactionHash, status: transfer.status
            });
        }
        history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        const sent: SentTransfer[] = [];
        for (const tx of history) {
            sent.push({
                timestamp: tx.timestamp, recipient: tx.recipient, contact: await this.contactName(tx.recipient),
                token: tx.token, amount: tx.amount, balance: tx.balance, status: tx.status,
                url: this.selectedNetwork.explorer + tx.hash
            });
        }
        return sent;
    }

    importActions(): HostAction[] {
        return [{ name: 'Import HODL File', run: ui => this.importHODLFile(ui) }];
    }

    exportActions(): HostAction[] {
        return [{ name: 'Export HODL File', run: ui => this.exportHODLFile(ui) }];
    }

    menuActions(): HostAction[] {
        return routeForNetwork(this.selectedNetwork.id) ? [{ name: 'Swap', run: () => this.swapFunds() }] : [];
    }

    async close(): Promise<void> {
        try {
            await this.db.dispose();
        } finally {
            this.securePersistFile();
            this.profileLock.release();
        }
    }

    private get storageNetworkName(): string { return networkStorageName(this.selectedNetwork); }

    private transferService(): TransferService {
        return new TransferService(this.db, this.selectedNetwork, this.network);
    }

    private transferPort(): TransferPort {
        return {
            pending: async (): Promise<PendingTransfer[]> => (await this.transferService().list())
                .filter(transfer => !['confirmed', 'failed'].includes(transfer.status))
                .map(transfer => ({
                    requestId: transfer.requestId!, to: transfer.to, asset: transfer.asset,
                    amount: transfer.amount, status: transfer.status
                })),
            preview: async ({ to, asset }) => {
                const preview = await this.transferService().send({ wallet: 'default', to, asset, amount: 'max', dryRun: true });
                return { amount: preview.amount, fee: preview.fee };
            },
            send: (draft, requestId) => this.transferService().send({
                wallet: 'default', to: draft.to, asset: draft.asset, amount: draft.amount, requestId, dryRun: false
            }),
            record: async (result: TransferResult, draft: TransferDraft): Promise<SentTransfer> => {
                const balance = (await this.network.getAssetBalance(result.from, draft.asset)).amount;
                await this.addToTransactions(draft.to, draft.asset, result.amount, result.transactionHash, balance);
                return {
                    timestamp: new Date(), recipient: draft.to, contact: await this.contactName(draft.to),
                    token: draft.asset, amount: result.amount, balance,
                    url: this.selectedNetwork.explorer + result.transactionHash
                };
            }
        };
    }

    private contactsPort(): ContactsPort {
        return {
            list: async (): Promise<Contact[]> => {
                const contacts = await this.db.entries('contact', this.storageNetworkName) || [];
                return contacts.map(([address, data]: [string, StoredContact]) => ({ address, name: data.name }));
            },
            get: async address => (await this.db.get('contact', this.storageNetworkName, address) as StoredContact | undefined)?.name,
            set: async (address, name) => { await this.db.set('contact', this.storageNetworkName, address, 'name', name); },
            delete: async address => { await this.db.del('contact', this.storageNetworkName, address); },
            clear: async () => { await this.db.del('contact'); }
        };
    }

    private async contactName(address: string): Promise<string | undefined> {
        return this.contacts.get(address);
    }

    private async addToTransactions(
        recipient: string,
        token: string,
        amount: string,
        hash: string,
        balance: string
    ): Promise<void> {
        const transaction = {
            timestamp: new Date().toISOString(),
            recipient,
            token,
            amount,
            hash,
            balance
        };
        const address = await this.address();
        const history = await this.db.values('transactions', address, this.selectedNetwork.nativeToken) as StoredTransaction[] || [];
        if (!history.some(entry => entry.hash === hash)) {
            await this.db.add('transactions', address, this.selectedNetwork.nativeToken, transaction);
        }
    }

    private async swapFunds(): Promise<void> {
        const route = routeForNetwork(this.selectedNetwork.id);
        if (!route) throw new Error('No swap route for the selected network.');
        await startSwapMenu(new SwapService(this.db, { routeId: route.id }));
    }

    private securePersistFile(): void {
        const persistPath = path.join(this.hodlDir, 'persist.json');
        if (fs.existsSync(persistPath)) {
            fs.chmodSync(persistPath, 0o600);
        }
    }

    private async exportHODLFile(ui: Ui): Promise<void> {
        const address = await this.address();
        const defaultFileName = `${address.slice(-6).toUpperCase()}`;
        let fileName = await ui.input({
            message: 'Enter the name for the HODL file:',
            default: defaultFileName
        });

        fileName += '.HODL';

        const data = await this.db.get();
        const encryptionKey = await askEncryptionKey(ui);

        try {
            const encryptedData = Persist.encrypt(data, encryptionKey);
            fs.writeFileSync(fileName, encryptedData);
        } finally {
            Persist.clearSensitiveData(data);
        }

        ui.table({ head: ['HODL File Exported'], tone: 'green', rows: [[`File saved as: ${fileName}`]] });
    }

    private async importHODLFile(ui: Ui): Promise<boolean> {
        // Scan current directory for .HODL files
        const currentDir = process.cwd();
        let hodlFiles: string[] = [];

        try {
            const files = fs.readdirSync(currentDir);
            hodlFiles = files.filter(file => file.endsWith('.HODL'));
        } catch (error) {
            console.error('Error reading directory:', errorMessage(error));
        }

        // Create file options array for autocomplete
        const fileOptions = hodlFiles.map(file => ({
            name: file,
            value: path.join(currentDir, file)
        }));

        // Use autocomplete pattern similar to transferFunds
        const filePath = await ui.autocomplete({
            message: 'HODL file path:',
            source: input => {
                const filenameOptions = fileOptions
                    .filter(entry => entry.name.toLowerCase().includes(input.toLowerCase()) || entry.value.toLowerCase().includes(input.toLowerCase()))
                    .map(entry => ({
                        name: entry.name,
                        value: entry.value
                    }));

                // Put path options first, then filename options, then manual input
                return [{ name: input, value: input }, ...filenameOptions];
            }
        });

        // If user leaves empty, skip the operation
        if (!filePath || filePath.trim() === '') {
            return false;
        }

        // Validate the file path
        if (!filePath.endsWith('.HODL')) {
            showError(ui, 'File must have .HODL extension');
            return false;
        }

        if (!fs.existsSync(filePath)) {
            showError(ui, 'File not found.');
            return false;
        }

        const encryptedData = fs.readFileSync(filePath, 'utf8');
        const encryptionKey = await askEncryptionKey(ui);

        let importedData: unknown;

        try {
            importedData = Persist.decrypt(encryptedData, encryptionKey);
            await this.db.set(importedData);
            const account = await this.getAccount();
            Persist.clearSensitiveData(account);
            return Boolean(account);
        } catch (error) {
            showError(ui, 'Failed to import HODL file.', 'The password is incorrect.');
            return false;
        } finally {
            Persist.clearSensitiveData(importedData);
        }
    }
}
