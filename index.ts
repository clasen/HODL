#!/usr/bin/env node

import fs from 'fs';
import crypto from 'node:crypto';
import { AgentError } from './agent-errors.js';
import { TransferService } from './transfer-service.js';
import type { TransferResult } from './transfer-service.js';
import path from 'path';
import inquirer from 'inquirer';
import Persist from './persist.js';
import { normalizeDecimal } from './amounts.js';
import { NetworkRegistry, networkStorageName } from './network-registry.js';
import { ProfileLock, ProfileLockedError } from './profile-lock.js';
import { SwapService } from './swap/service.js';
import { routeForNetwork } from './swap/routes.js';
import { startSwapMenu } from './swap/ui.js';
import { fileURLToPath } from 'url';
import Table from 'cli-table3';
import os from 'os';
import ora from 'ora';
import type {
    BaseNetworkContract,
    NetworkPlugin,
    NetworkUsage,
    NetworkUsageEntry,
    WalletAccount
} from './network/types.js';

type PromptSourceChoice = { name: string; value: string };
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

const AnyTable: any = Table;
const __filename = fileURLToPath(import.meta.url);

function suppressPunycodeDeprecationWarning(): void {
    const warningListeners = process.rawListeners('warning');
    process.removeAllListeners('warning');
    process.on('warning', warning => {
        if ((warning as Error & { code?: string }).code === 'DEP0040') {
            return;
        }
        warningListeners.forEach(listener => listener.call(process, warning));
    });
}

suppressPunycodeDeprecationWarning();

function isNetworkUsageEntry(value: unknown): value is NetworkUsageEntry {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        typeof (value as Partial<NetworkUsageEntry>).count === 'number'
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

import inquirerAutocomplete from 'inquirer-autocomplete-prompt';
inquirer.registerPrompt('autocomplete', inquirerAutocomplete);

class Wallet {
    private db: Persist;
    private network: BaseNetworkContract;
    private selectedNetwork: NetworkPlugin;
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

        this.network = null as unknown as BaseNetworkContract;
        this.selectedNetwork = null as unknown as NetworkPlugin;
        this.networkUsage = {};
    }

    async connect(): Promise<void> {
        await this.db.connect();
        this.securePersistFile();
    }

    hasStoredDatabase(): boolean {
        return this.databaseExisted;
    }

    /**
     * @param {number | string} num
     * @returns {string}
     */
    formatAmount(num: number | string): string {
        num = parseFloat(num.toString());

        // Handle integers - add .00
        if (num === Math.floor(num)) {
            return num.toString() + '.00';
        }

        // For decimals, format to max 3 decimal places, then remove trailing zeros
        let formatted = num.toFixed(3);

        // Remove trailing zeros, but keep at least 2 decimal places
        while (formatted.endsWith('0') && formatted.split('.')[1].length > 2) {
            formatted = formatted.slice(0, -1);
        }

        return formatted;
    }

    async initialize(): Promise<void> {
        try {
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

            const networkPlugins = await this.loadNetworkPlugins();
            if (networkPlugins.length === 0) {
                throw new Error('No valid network plugins found.');
            }
            await this.selectNetwork(networkPlugins, { autoSelect: true });
            this.network = new this.selectedNetwork.NetworkClass(this.selectedNetwork);
            this.network.name = this.selectedNetwork.name;

            await this.loadAccount();

            if (!await this.hasAccount()) {
                throw new Error('Failed to initialize account.');
            }

        } catch (error) {
            throw new Error(`Initialization failed: ${errorMessage(error)}`);
        }
    }

    /**
     * @param {WalletAccount | any} account
     * @returns {void}
     */
    async setAccount(account: WalletAccount | null): Promise<void> {
        if (!account) {
            return;
        }

        await this.db.set('account', this.network.constructor.name, account);
        if (account.mnemonic) {
            await this.db.set('mnemonic', account.mnemonic);
        }
    }

    async getAccount(): Promise<WalletAccount | null> {
        const account = await this.db.get('account', this.network.constructor.name);

        return account ?? null;
    }

    async getAddress(): Promise<string> {
        return this.db.get('account', this.network.constructor.name, 'address');
    }

    async getMnemonic(): Promise<string | null> {
        return await this.db.get('mnemonic') ?? null;
    }

    async hasAccount(): Promise<boolean> {
        return typeof await this.db.get(
            'account',
            this.network.constructor.name,
            'address'
        ) === 'string';
    }

    async displayAccountAddress(): Promise<void> {

        const table = new AnyTable({
            head: [`${this.selectedNetwork.name} Address`],
            style: {
                head: ['green']
            }
        });

        table.push([await this.getAddress()]);
        console.log(table.toString());
    }

    /**
     * @returns {Promise<NetworkPlugin[]>}
     */
    async loadNetworkPlugins(): Promise<NetworkPlugin[]> {
        return new NetworkRegistry().list();
    }

    /**
     * @param {NetworkPlugin[]} networkPlugins
     * @param {{ autoSelect?: boolean }} [options]
     * @returns {Promise<void>}
     */
    async selectNetwork(
        networkPlugins: NetworkPlugin[],
        { autoSelect = false }: { autoSelect?: boolean } = {}
    ): Promise<void> {
        // Sort networks by last used timestamp (most recent first)
        const sortedNetworks = networkPlugins.sort((a, b) => {
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

        let selectedNetwork: NetworkPlugin | undefined;

        if (autoSelect) {
            // Automatically select the first network (most recently used)
            selectedNetwork = sortedNetworks[0];
        } else {
            // Let user choose the network
            const { network } = await inquirer.prompt({
                type: 'list',
                name: 'network',
                message: 'Select the network:',
                choices: sortedNetworks.map(plugin => plugin.name),
            });
            selectedNetwork = sortedNetworks.find(plugin => plugin.name === network);
        }

        if (!selectedNetwork) {
            throw new Error('Selected network was not found.');
        }

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
    }

    /**
     * @param {boolean} [loggedIn]
     * @returns {Promise<void>}
     */
    async loadAccount(loggedIn = false): Promise<void> {
        let accountExists = await this.hasAccount();

        const mainChoices = ['Create New Account'];

        if (loggedIn) {
            mainChoices.push('Import Options');
            mainChoices.push('Export Options');
            mainChoices.push('Switch Network');
            mainChoices.push('Manage Address Book');
            mainChoices.push('Go Back');
        } else {
            mainChoices.push('Import HODL File');
            mainChoices.push('Import Mnemonic (12 or 24 words)');
            mainChoices.push('Import Private-key');
        }

        if (!accountExists || loggedIn) {
            let { accountAction } = await inquirer.prompt({
                type: 'list',
                name: 'accountAction',
                message: 'Select an account option:',
                choices: mainChoices,
            });

            if (accountAction === 'Go Back') {
                return;
            }

            if (accountAction === 'Manage Address Book') {
                const addressBookChoices = ['Delete Address', 'Go Back'];
                const { addressBookAction } = await inquirer.prompt({
                    type: 'list',
                    name: 'addressBookAction',
                    message: 'Select an address book option:',
                    choices: addressBookChoices,
                });

                if (addressBookAction === 'Go Back') {
                    return this.loadAccount(loggedIn);
                }

                switch (addressBookAction) {
                    case 'Delete Address':
                        await this.deleteFromAddressBook();
                        break;
                }
                return;
            }

            if (accountAction === 'Import Options') {
                const importChoices = ['Import HODL File', 'Import Mnemonic (12 or 24 words)', 'Import Private-key', 'Go Back'];
                const { importAction } = await inquirer.prompt({
                    type: 'list',
                    name: 'importAction',
                    message: 'Select an import option:',
                    choices: importChoices,
                });

                if (importAction === 'Go Back') {
                    return this.loadAccount(loggedIn);
                }

                const confirmOverwrite = await this.confirmOverwrite();
                if (!confirmOverwrite) return;

                accountAction = importAction;
            }

            switch (accountAction) {
                case 'Import Mnemonic (12 or 24 words)':
                    const account = await this.importFromMnemonic();
                    if (!account) {
                        // Wallet.displayError('Invalid mnemonic.');
                        return;
                    }
                    await this.setAccount(account);
                    Persist.clearSensitiveData(account);
                    await this.displayAccountAddress();
                    accountExists = true;
                    break;
                case 'Import Private-key':
                    await this.importPrivateKey();
                    break;
                case 'Import HODL File':
                    const importedAccount = await this.importHODLFile();
                    if (importedAccount) {
                        Persist.clearSensitiveData(importedAccount);
                        await this.displayAccountAddress();
                        accountExists = true;
                    }
                    break;
            }

            if (accountAction === 'Export Options') {
                const exportChoices = ['Export HODL File', 'Export Private-key', 'Go Back'];
                const { exportAction } = await inquirer.prompt({
                    type: 'list',
                    name: 'exportAction',
                    message: 'Select an export option:',
                    choices: exportChoices,
                });

                if (exportAction === 'Go Back') {
                    return this.loadAccount(loggedIn);
                }

                switch (exportAction) {
                    case 'Export Private-key':
                        await this.displayAccountDetails();
                        break;
                    case 'Export HODL File':
                        await this.exportHODLFile();
                        break;
                }
                return;
            }


            if (accountAction === 'Create New Account') {
                const confirmOverwrite = await this.confirmOverwrite();
                if (!confirmOverwrite) return;
                await this.createNewAccount();
            }

            if (accountAction === 'Switch Network') {
                await this.switchNetwork();
            }

            return;
        }

        if (!accountExists) {
            throw new Error('Account was not initialized.');
        }
    }

    /**
     * @returns {Promise<boolean>}
     */
    async confirmOverwrite(): Promise<boolean> {
        if (await this.hasAccount()) {
            const { confirmOverwrite } = await inquirer.prompt({
                type: 'confirm',
                name: 'confirmOverwrite',
                message: 'This action will overwrite the existing account. Are you sure you want to continue?',
                default: false,
            });

            return confirmOverwrite;
        }

        return true;
    }

    /**
     * @returns {Promise<WalletAccount | null>}
     */
    async importFromMnemonic(): Promise<WalletAccount | null> {
        const { mnemonic } = await inquirer.prompt({
            type: 'password',
            name: 'mnemonic',
            message: 'Enter your mnemonic phrase (12 or 24 words):',
            mask: '*',
            validate: (input: string) => {
                if (input.trim() === '') return true;
                return this.network.validateMnemonic(input) || 'Please enter a valid mnemonic phrase or leave empty to cancel.';
            }
        });

        if (!mnemonic.trim()) return null;

        return this.network.accountFromMnemonic(mnemonic);
    }

    async showBalance(): Promise<void> {
        if (!await this.hasAccount()) {
            Wallet.displayError('Account not initialized.');
            return;
        }

        const balances = await this.network.getTokenBalances(await this.getAddress());

        const table = new AnyTable({
            head: ['Token', 'Balance'],
            style: { head: ['blue'] },
            colWidths: [21, 22]
        });

        balances.forEach(([token, balance]) => {
            table.push([token, token === 'USDT' ? Number(balance).toFixed(2) : this.formatAmount(balance)]);
        });

        console.log(table.toString());
    }

    async transferFunds(): Promise<void> {
        const service = new TransferService(this.db, this.selectedNetwork, this.network);
        const pending = (await service.list()).filter(transfer => !['confirmed', 'failed'].includes(transfer.status));
        if (pending.length) {
            const { requestId } = await inquirer.prompt({
                type: 'list', name: 'requestId', message: 'A previous transfer is still pending:',
                choices: [
                    ...pending.map(transfer => ({
                        name: `Check / resume ${transfer.amount} ${transfer.asset} to ${transfer.to} (${transfer.status})`,
                        value: transfer.requestId
                    })),
                    { name: 'New transfer', value: 'new' },
                    { name: 'Go back', value: 'back' }
                ]
            });
            if (requestId === 'back') return;
            if (requestId !== 'new') {
                const transfer = pending.find(item => item.requestId === requestId)!;
                await this.submitTransfer(service, transfer.to, transfer.asset, transfer.amount, requestId);
                return;
            }
        }
        const contacts = await this.db.entries('contact', this.storageNetworkName) || [];
        const addressBook = contacts.map(([address, data]: [string, StoredContact]) => ({
            address,
            name: data.name
        }));

        addressBook.push({ name: 'Go Back', address: '' });

        // Implement autocomplete for address book
        const { recipient } = await inquirer.prompt({
            type: 'autocomplete',
            name: 'recipient',
            message: 'Recipient address:',
            source: (_answersSoFar: Record<string, unknown>, input = ''): PromptSourceChoice[] => {
                input = input || '';
                return addressBook
                    .filter(entry => entry.name.toLowerCase().includes(input.toLowerCase()) || entry.address.toLowerCase().includes(input.toLowerCase()))
                    .map(entry => ({
                        name: entry.address ? `${entry.address} (${entry.name})` : entry.name,
                        value: entry.address
                    }))
                    .concat([{ name: input, value: input }]); // Add the input as a possible choice
            },
        });

        if (!recipient) return;

        let address = recipient;


        const choices = Object.keys(this.selectedNetwork.tokens);
        choices.push(this.selectedNetwork.nativeToken);

        let token = this.selectedNetwork.nativeToken;
        if (choices.length > 1) {
            token = (await inquirer.prompt({
                type: 'list',
                name: 'token',
                message: 'Token to transfer:',
                choices,
            })).token;
        }

        const { amount } = await inquirer.prompt({
            type: 'input',
            name: 'amount',
            message: `Amount to transfer (or max):`,
            validate: (value: string) => {
                if (value.trim() === '' || value.trim().toLowerCase() === 'max') return true;
                try {
                    normalizeDecimal(value.trim());
                    return true;
                } catch {
                    return 'Please enter a valid decimal amount, max, or leave empty to cancel.';
                }
            },
        });

        if (amount.trim() === '') {
            return;
        }

        let transferAmount = amount.trim();
        if (transferAmount.toLowerCase() === 'max') {
            try {
                const preview = await service.send({ wallet: 'default', to: address, asset: token, amount: 'max', dryRun: true });
                transferAmount = preview.amount;
                console.log(`Maximum: ${preview.amount} ${token} | Estimated fee: ${preview.fee.amount} ${preview.fee.asset}`);
            } catch (error) {
                this.displayTransactionError(error);
                return;
            }
        }

        // Add confirmation step
        const { confirmTransaction } = await inquirer.prompt({
            type: 'confirm',
            name: 'confirmTransaction',
            message: amount.trim().toLowerCase() === 'max'
                ? `Confirm transfer of maximum available ${token} (estimated ${transferAmount})?`
                : `Confirm transfer of ${transferAmount} ${token}?`,
            default: true
        });

        if (!confirmTransaction) {
            return;
        }

        await this.submitTransfer(service, address, token, amount.trim().toLowerCase() === 'max' ? 'max' : transferAmount, crypto.randomUUID());
    }

    private async submitTransfer(
        service: TransferService, address: string, token: string, amount: string, requestId: string
    ): Promise<void> {
        const spinner = ora({ text: 'Checking / sending transaction...', spinner: 'dots' }).start();
        let result: TransferResult;
        try {
            result = await service.send({ wallet: 'default', to: address, asset: token, amount, requestId, dryRun: false });
        } catch (error) {
            spinner.fail('Could not complete the transfer request.');
            this.displayTransactionError(error);
            if (error instanceof AgentError && error.details?.transactionHash) {
                console.log(`Saved transfer: ${error.details.requestId}`);
                console.log(this.selectedNetwork.explorer + error.details.transactionHash);
            } else {
                console.log(`Request ID: ${requestId}`);
            }
            console.log('Open Transfer Funds to check or resume any saved request before creating another payment.');
            return;
        }

        spinner.succeed(result.status === 'confirmed' ? 'Transaction confirmed!' : 'Transaction submitted; awaiting confirmation.');
        console.log(`Request ID: ${requestId}`);
        console.log(this.selectedNetwork.explorer + result.transactionHash);
        try {
            const currentBalance = (await this.network.getAssetBalance(result.from, token)).amount;
            await this.addToTransactions(address, token, result.amount, result.transactionHash, currentBalance);
            await this.displayTransactionResult(address, token, result.amount, result.transactionHash, currentBalance);
            const existingContact = await this.db.get('contact', this.storageNetworkName, address);
            if (!existingContact) await this.addToAddressBook(address);
        } catch (error) {
            Wallet.displayError('Transfer recorded; could not update balance, history or contact.', errorMessage(error));
        }
    }

    /**
     * @param {any} error
     * @returns {void}
     */
    displayTransactionError(error: unknown): void {
        const reason = typeof error === 'object' && error !== null && 'reason' in error
            ? String(error.reason)
            : null;
        const message = error instanceof Error ? error.message : errorMessage(error);
        const data = reason ? reason.replace(/(\w+):/g, "\n$1:").trim() : null;
        Wallet.displayError(message, data);
    }

    /**
     * @param {string} message
     * @param {unknown} [data]
     * @returns {void}
     */
    static displayError(message: string, data?: unknown): void {
        const table = new AnyTable({
            head: [message],
            style: { head: ['red'] },
            wordWrap: true,
        });

        if (data) {
            table.push([data.toString()]);
        }

        console.log(table.toString());
    }

    /**
     * @param {string | number | Date} date
     * @returns {string}
     */
    formatDate(date: string | number | Date): string {
        return new Date(date).toLocaleString('en-GB', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1').replace(",", "");
    }

    /**
     * @param {string} recipient
     * @param {string} token
     * @param {string} amount
     * @param {string} hash
     * @param {string} balance
     * @returns {Promise<void>}
     */
    async addToTransactions(
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
        const address = await this.getAddress();
        const history = await this.db.values('transactions', address, this.selectedNetwork.nativeToken) as StoredTransaction[] || [];
        if (!history.some(entry => entry.hash === hash)) {
            await this.db.add('transactions', address, this.selectedNetwork.nativeToken, transaction);
        }
    }

    async showTransactions(): Promise<void> {
        const address = await this.getAddress();
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

        const transfers = await new TransferService(this.db, this.selectedNetwork, this.network).list();
        for (const transfer of transfers.filter(item => item.from === address)) {
            const existing = history.find(item => item.hash === transfer.transactionHash);
            if (existing) existing.status = transfer.status;
            else history.push({
                timestamp: transfer.createdAt, recipient: transfer.to, token: transfer.asset,
                amount: transfer.amount, hash: transfer.transactionHash, status: transfer.status
            });
        }
        history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        const table = new AnyTable({
            head: ['Date', 'Recipient', 'Contact', 'Token', 'Amount', 'Balance', 'Status'],
            style: { head: ['blue'] },
        });

        if (history.length === 0) {
            table.push([{ colSpan: 7, content: 'No transaction history available.' }]);
        }

        for (const tx of history) {
            const date = this.formatDate(tx.timestamp);
            const contact = await this.db.get('contact', this.storageNetworkName, tx.recipient) as StoredContact | undefined;
            const contactName = contact ? contact.name : '-';
            const amount = this.formatAmount(tx.amount);
            const balance = tx.balance !== undefined ? this.formatAmount(tx.balance) : '-';
            table.push([date, tx.recipient, contactName, tx.token, amount, balance, tx.status || '-']);
            table.push([{ colSpan: 7, content: this.selectedNetwork.explorer + tx.hash }]);
        }

        console.log(table.toString());
    }

    /**
     * @param {string} address
     * @returns {Promise<void>}
     */
    async addToAddressBook(address: string): Promise<void> {
        const { name } = await inquirer.prompt({
            type: 'input',
            name: 'name',
            message: 'Name for the address book (leave empty to skip):',
        });

        if (name.trim() !== '') {
            await this.db.set('contact', this.storageNetworkName, address, 'name', name);

            const table = new AnyTable({
                head: [{ colSpan: 2, content: "Recipient saved to the address book." }],
                style: { head: ['green'] },
            });

            table.push([name, address]);
            console.log(table.toString());
        }
    }

    async deleteFromAddressBook(): Promise<void> {
        const contacts = await this.db.get('contact', this.storageNetworkName) as Record<string, StoredContact> || {};
        const addressBook = Object.entries(contacts).map(([address, data]) => ({
            address,
            name: data.name
        }));

        if (addressBook.length === 0) {
            const table = new AnyTable({
                head: ['Address Book'],
                style: { head: ['yellow'] },
            });
            table.push(['No addresses in the address book.']);
            console.log(table.toString());
            return;
        }

        addressBook.push({ name: 'Go Back', address: '' });

        const { addressToDelete } = await inquirer.prompt({
            type: 'list',
            name: 'addressToDelete',
            message: 'Select an address to delete:',
            choices: addressBook.map(entry => ({
                name: entry.address ? `${entry.address} (${entry.name})` : entry.name,
                value: entry.address
            }))
        });

        if (!addressToDelete) return;

        const { confirmDelete } = await inquirer.prompt({
            type: 'confirm',
            name: 'confirmDelete',
            message: 'Are you sure you want to delete this address?',
            default: false
        });

        if (confirmDelete) {
            await this.db.del('contact', this.storageNetworkName, addressToDelete);
            const table = new AnyTable({
                head: ['Address Book'],
                style: { head: ['green'] },
            });
            table.push(['Address deleted successfully.']);
            console.log(table.toString());
        }
    }

    /**
     * @param {string} address
     * @param {string} token
     * @param {string} amount
     * @param {string} hash
     * @param {string} balance
     * @returns {Promise<void>}
     */
    async displayTransactionResult(
        address: string,
        token: string,
        amount: string,
        hash: string,
        balance: string
    ): Promise<void> {
        const table = new AnyTable({
            head: ['Date', 'Recipient', 'Contact', 'Token', 'Amount', 'Balance'],
            style: { head: ['green'] },
        });

        const date = this.formatDate(new Date());

        const contact = await this.db.get('contact', this.storageNetworkName, address) as StoredContact | undefined;
        const contactName = contact ? contact.name : '-';

        table.push([date, address, contactName, token, this.formatAmount(amount), this.formatAmount(balance)]);
        table.push([{ colSpan: 6, content: this.selectedNetwork.explorer + hash }]);

        console.log(table.toString());
    }

    async clearAccountData(): Promise<void> {
        try {
            await this.db.dispose();
        } finally {
            this.securePersistFile();
            this.profileLock.release();
        }
    }

    private get storageNetworkName(): string { return networkStorageName(this.selectedNetwork); }

    getSwapRoute() { return routeForNetwork(this.selectedNetwork.id); }

    async swapFunds(): Promise<void> {
        const route = this.getSwapRoute();
        if (!route) throw new Error('No swap route for the selected network.');
        await startSwapMenu(new SwapService(this.db, { routeId: route.id }));
    }

    private securePersistFile(): void {
        const persistPath = path.join(this.hodlDir, 'persist.json');
        if (fs.existsSync(persistPath)) {
            fs.chmodSync(persistPath, 0o600);
        }
    }

    async displayAccountDetails(): Promise<void> {

        const table = new AnyTable({
            head: [{ colSpan: 2, content: 'Account Details' }],
            style: { head: ['green'] },
            wordWrap: true
        });

        const account = await this.getAccount();
        if (!account) {
            Wallet.displayError('Account not initialized.');
            return;
        }
        table.push(
            ['Address', await this.getAddress()],
            ['Private-key', account.privateKey]
        );

        const mnemonic = await this.getMnemonic();
        if (mnemonic) {
            table.push(['Mnemonic Phrase', mnemonic]);
            table.push(['WARNING', "Please keep your private-key and mnemonic phrase secure. Never share it."]);
        } else {
            table.push(['WARNING', "Please keep your private-key secure. Never share it."]);
        }

        console.log(table.toString());
        Persist.clearSensitiveData(account);
    }

    async switchNetwork(): Promise<void> {
        const networkPlugins = await this.loadNetworkPlugins();
        await this.selectNetwork(networkPlugins);
        this.network = new this.selectedNetwork.NetworkClass(this.selectedNetwork);
        this.network.name = this.selectedNetwork.name;

        if (await this.hasAccount()) {
            await this.displayAccountAddress();
        } else {
            console.log(`\nNo account found for ${this.selectedNetwork.name}. Please create or import an account.`);
            await this.loadAccount(true);
        }
    }

    async exportHODLFile(): Promise<void> {
        const address = await this.getAddress();
        const defaultFileName = `${address.slice(-6).toUpperCase()}`;
        let { fileName } = await inquirer.prompt({
            type: 'input',
            name: 'fileName',
            message: 'Enter the name for the HODL file:',
            default: defaultFileName
        });

        fileName += '.HODL';

        const data = await this.db.get();
        const encryptionKey = await UIManager.getEncryptionKey();

        try {
            const encryptedData = Persist.encrypt(data, encryptionKey);
            fs.writeFileSync(fileName, encryptedData);
        } finally {
            Persist.clearSensitiveData(data);
        }

        const table = new AnyTable({
            head: ['HODL File Exported'],
            style: { head: ['green'] }
        });
        table.push([`File saved as: ${fileName}`]);
        console.log(table.toString());
    }

    async importHODLFile(): Promise<WalletAccount | null> {
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
        const { filePath } = await inquirer.prompt({
            type: 'autocomplete',
            name: 'filePath',
            message: 'HODL file path:',
            source: (_answersSoFar: Record<string, unknown>, input = ''): PromptSourceChoice[] => {
                input = input || '';

                const filenameOptions = fileOptions
                    .filter(entry => entry.name.toLowerCase().includes(input.toLowerCase()) || entry.value.toLowerCase().includes(input.toLowerCase()))
                    .map(entry => ({
                        name: entry.name,
                        value: entry.value
                    }));

                // Put path options first, then filename options, then manual input
                return [{ name: input, value: input }, ...filenameOptions];
            },
        });

        // If user leaves empty, skip the operation
        if (!filePath || filePath.trim() === '') {
            return null;
        }

        // Validate the file path
        if (!filePath.endsWith('.HODL')) {
            Wallet.displayError('File must have .HODL extension');
            return null;
        }

        if (!fs.existsSync(filePath)) {
            Wallet.displayError('File not found.');
            return null;
        }

        const encryptedData = fs.readFileSync(filePath, 'utf8');
        const encryptionKey = await UIManager.getEncryptionKey();

        let importedData: unknown;

        try {
            importedData = Persist.decrypt(encryptedData, encryptionKey);
            await this.db.set(importedData);
            return await this.getAccount();
        } catch (error) {
            Wallet.displayError('Failed to import HODL file.', 'The password is incorrect.');
            return null;
        } finally {
            Persist.clearSensitiveData(importedData);
        }
    }

    async importPrivateKey(): Promise<void> {
        const { privateKey } = await inquirer.prompt({
            type: 'password',
            name: 'privateKey',
            message: 'Private-key (leave empty to cancel):',
            mask: '*',
            validate: (input: string) => {
                if (input.trim() === '') return true;
                return this.network.validatePrivateKey(input) ||
                    'Please enter a valid private-key for the selected network or leave empty to cancel.';
            }
        });

        if (!privateKey.trim()) {
            return;  // Silently return if empty
        }

        try {
            await this.setAccount(await this.network.privateKeyToAccount(privateKey));
            await this.displayAccountAddress();
        } catch (error) {
            Wallet.displayError('Invalid private-key.');
        }
    }

    async createNewAccount(): Promise<void> {
        let existingMnemonic = await this.getMnemonic();
        let useMnemonic = false;

        if (existingMnemonic) {
            const { useExistingMnemonic } = await inquirer.prompt({
                type: 'confirm',
                name: 'useExistingMnemonic',
                message: 'Use existing mnemonic to create account?',
                default: true
            });

            if (useExistingMnemonic) {
                useMnemonic = true;
                await this.setAccount(await this.network.accountFromMnemonic(existingMnemonic));
                existingMnemonic = null;
            }
        }

        if (!useMnemonic) {
            const { createWithMnemonic } = await inquirer.prompt({
                type: 'confirm',
                name: 'createWithMnemonic',
                message: 'Create account with mnemonic?',
                default: true
            });

            if (createWithMnemonic) {
                // Ask for mnemonic word count
                const { wordCount } = await inquirer.prompt({
                    type: 'list',
                    name: 'wordCount',
                    message: 'Choose mnemonic phrase length:',
                    choices: [
                        { name: '12 words (standard)', value: 12 },
                        { name: '24 words (more secure)', value: 24 }
                    ],
                    default: 12
                });

                await this.setAccount(await this.network.createAccountFromMnemonic(wordCount as 12 | 24));
            } else {
                await this.setAccount(await this.network.createAccount());
            }
        }

        // Check if there are addresses in the address book
        const addressBook = await this.db.entries('contact', this.storageNetworkName) || [];

        if (addressBook.length > 0) {
            const { deleteAddresses } = await inquirer.prompt({
                type: 'confirm',
                name: 'deleteAddresses',
                message: `Do you want to delete all ${addressBook.length} addresses from the previous account?`,
                default: false
            });

            if (deleteAddresses) {

                await this.db.del('contact');

                const table = new AnyTable({
                    head: ['Address Book'],
                    style: { head: ['green'] },
                });
                table.push(['All addresses deleted successfully.']);
                console.log(table.toString());
            }
        }

        let message = 'Do you want to display sensitive information (private key';
        if (await this.getMnemonic()) {
            message += ' and mnemonic';
        }
        message += ')?';

        const { showSensitive } = await inquirer.prompt({
            type: 'confirm',
            name: 'showSensitive',
            message,
            default: false,
        });

        if (showSensitive) {
            await this.displayAccountDetails();
        } else {
            await this.displayAccountAddress();
        }
    }
}

class UIManager {
    static displayWelcome(): void {
        console.log('\x1b[32m');  // Set text color to green
        console.log(` ░░░░░░░░░░░░░░ █ █ █▀█ █▀▄ █   ░░░░░░░░░░░░░░
 ░░░░░░░░░░░░░░ █▀█ █▄█ █▄▀ █▄▄ ░░░░░░░░░░░░░░
 ░░░░░░░░░░░░░░ ──────── WALLET ░░░░░░░░░░░░░░`);
        console.log('\x1b[0m');  // Reset text color
    }

    static async getEncryptionKey(): Promise<string> {
        const { key } = await inquirer.prompt({
            type: 'password',
            name: 'key',
            message: 'Password:',
            mask: '*',
        });
        return key;
    }

    static async confirmEncryptionKey(): Promise<string> {
        const { confirmKey } = await inquirer.prompt({
            type: 'password',
            name: 'confirmKey',
            message: 'Repeat Password:',
            mask: '*',
        });
        return confirmKey;
    }

    static displayExitPhrase(): void {
        const phrases = [
            "Buy the rumor, sell the news",
            "The trend is your friend",
            "Don't fight the tape",
            "Cut your losses and let your profits run",
            "Be fearful when others are greedy, and greedy when others are fearful",
            "The market can remain irrational longer than you can remain solvent",
            "Bulls make money, bears make money, pigs get slaughtered",
            "No one is bigger than the market",
            "Don't catch a falling knife",
            "Past performance is not indicative of future results",
            "The stock market is a device for transferring money from the impatient to the patient",
            "Time in the market beats timing the market",
            "Buy low, sell high",
            "Diversification is the only free lunch in investing",
            "The four most dangerous words in investing are: 'This time it's different'",
            "Markets can remain irrational a lot longer than you and I can remain solvent",
            "Risk comes from not knowing what you're doing",
            "In the short run, the market is a voting machine. In the long run, it's a weighing machine",
            "Invest in yourself. Your career is the engine of your wealth",
            "Who has the gold makes the rules",
            "The best time to invest was yesterday. The second best time is now",
            "Don't put all your eggs in one basket",
            "Knowledge is power in the world of investing",
            "Patience is a virtue in the stock market",
            "The market is never wrong, but opinions often are"
        ];
        const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];

        const table = new AnyTable({
            head: ['✨ Good bye!'],
            style: { head: ['yellow'] },
            wordWrap: true,
        });

        table.push([randomPhrase]);

        console.log(table.toString());
    }
}

async function mainMenu(wallet: Wallet): Promise<void> {
    const route = wallet.getSwapRoute();
    const { action } = await inquirer.prompt({
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
            { name: 'Transfer Funds', value: 'transferFunds' },
            { name: 'Show Balance', value: 'balance' },
            { name: 'Show Sent Transfers', value: 'showTransactions' },
            { name: 'Account Settings', value: 'account' },
            ...(route ? [{ name: 'Swap', value: 'swapFunds' }] : []),
            { name: 'Exit', value: 'exit' }
        ],
    });

    switch (action) {
        case 'swapFunds':
            await wallet.swapFunds();
            return mainMenu(wallet);
        case 'transferFunds':
            await wallet.transferFunds();
            return mainMenu(wallet);
        case 'balance':
            await wallet.showBalance();
            return mainMenu(wallet);
        case 'showTransactions':
            await wallet.showTransactions();
            return mainMenu(wallet);
        case 'account':
            await wallet.loadAccount(true);
            return mainMenu(wallet);
        case 'exit':
            return;
    }
}

let activeWallet: Wallet | null = null;
let shutdownPromise: Promise<void> | null = null;

async function shutdown(): Promise<void> {
    if (!shutdownPromise) {
        shutdownPromise = (async () => {
            if (activeWallet) {
                await activeWallet.clearAccountData();
                activeWallet = null;
            }
            UIManager.displayExitPhrase();
        })();
    }

    await shutdownPromise;
}

async function run(): Promise<void> {
    UIManager.displayWelcome();
    const hodlDir = path.join(os.homedir(), '.HODL');
    fs.mkdirSync(hodlDir, { recursive: true, mode: 0o700 });
    const profileLock = new ProfileLock(path.join(hodlDir, '.default.lock'));
    try {
        profileLock.acquire();
    } catch (error) {
        if (!(error instanceof ProfileLockedError)) {
            throw error;
        }
        Wallet.displayError(error.owner === null
            ? 'The HODL profile is locked. Close the other instance and try again.'
            : `HODL is already open in another terminal (PID ${error.owner}). Close that instance and try again.`);
        return;
    }
    let encryptionKey: string | null = null;

    try {
        encryptionKey = await UIManager.getEncryptionKey();
        const wallet = new Wallet(encryptionKey, profileLock);
        activeWallet = wallet;
        const databaseExisted = wallet.hasStoredDatabase();

        try {
            await wallet.connect();
        } catch (error) {
            console.error(errorMessage(error));
            Wallet.displayError('Wrong password.');
            process.exitCode = 1;
            return;
        }

        if (!databaseExisted) {
            const confirmedKey = await UIManager.confirmEncryptionKey();
            if (confirmedKey !== encryptionKey) {
                Wallet.displayError('Passwords do not match. Please try again.');
                process.exitCode = 1;
                return;
            }
        }

        encryptionKey = null;

        try {
            await wallet.initialize();
            await wallet.displayAccountAddress();
            await mainMenu(wallet);
        } catch (error) {
            Wallet.displayError('Failed to initialize wallet.', error);
            process.exitCode = 1;
        }
    } finally {
        encryptionKey = null;
        try {
            await shutdown();
        } finally {
            profileLock.release();
        }
    }
}

export function selectCliMode(argv: string[]): 'interactive' | 'agent' {
    return argv.length === 0 ? 'interactive' : 'agent';
}

interface CliDependencies {
    runInteractive?: () => Promise<void>;
    runAgent?: (argv: string[]) => Promise<number>;
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
    if (selectCliMode(argv) === 'agent') {
        const runAgent = dependencies.runAgent || (await import('./agent-cli.js')).runAgentCli;
        return runAgent(argv);
    }

    await (dependencies.runInteractive || run)();
    return 0;
}

async function runEntrypoint(argv: string[]): Promise<void> {
    if (selectCliMode(argv) === 'agent') {
        process.removeAllListeners('warning');
        process.on('warning', () => undefined);
        process.exitCode = await runCli(argv);
        return;
    }

    process.once('SIGINT', () => {
        void shutdown().finally(() => process.exit(130));
    });

    try {
        process.exitCode = await runCli(argv);
    } catch (error) {
        if (!(error instanceof Error && error.name === 'ExitPromptError')) {
            Wallet.displayError('Unexpected error.', error);
            process.exitCode = 1;
        }
        await shutdown();
    }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename)) {
    void runEntrypoint(process.argv.slice(2));
}
