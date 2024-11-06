#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import Persist from './persist.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Table from 'cli-table3';
import os from 'os';
import inquirerFuzzyPath from 'inquirer-fuzzy-path';
import ora from 'ora';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import inquirerAutocomplete from 'inquirer-autocomplete-prompt';
inquirer.registerPrompt('autocomplete', inquirerAutocomplete);
inquirer.registerPrompt('fuzzypath', inquirerFuzzyPath);

process.on('SIGINT', () => {
    process.exit();
});

class Wallet {
    constructor(encryptionKey) {
        const hodlDir = path.join(os.homedir(), '.HODL');

        if (!fs.existsSync(hodlDir)) {
            fs.mkdirSync(hodlDir, { recursive: true });
        }

        this.db = new Persist({ path: hodlDir, encryptionKey });

        this.network = null;
        this.selectedNetwork = null;
        this.networkUsage = this.db.get('networkUsage') || {};
    }

    async initialize() {
        try {
            const networkPlugins = await this.loadNetworkPlugins();
            if (networkPlugins.length === 0) {
                Wallet.displayError('No valid network plugins found.');
                process.exit(1);
            }
            await this.selectNetwork(networkPlugins);
            this.network = new this.selectedNetwork.NetworkClass(this.selectedNetwork);
            this.network.name = this.selectedNetwork.name;

            await this.loadAccount();

            if (!this.getAccount()) {
                Wallet.displayError('Failed to initialize account.');
                process.exit(1);
            }

        } catch (error) {
            Wallet.displayError('Initialization failed', error);
            process.exit(1);
        }
    }

    setAccount(account) {
        this.db.set('account', this.network.constructor.name, account);
        if (account.mnemonic) {
            this.db.set('mnemonic', account.mnemonic);
        }
    }

    getAccount() {
        return this.db.get('account', this.network.constructor.name);
    }

    getAddress() {
        return this.db.get('account', this.network.constructor.name, 'address');
    }

    getMnemonic() {
        return this.db.get('mnemonic');
    }

    displayAccountAddress() {
        const table = new Table({
            head: ['Account Address'],
            style: {
                head: ['green']
            }
        });
        table.push([this.getAddress()]);
        console.log(table.toString());
    }

    async loadNetworkPlugins() {
        const pluginsDir = path.join(__dirname, 'network');
        const pluginFiles = fs.readdirSync(pluginsDir).filter(file => file.endsWith('.js'));

        const networks = await Promise.all(pluginFiles.map(async file => {
            const plugin = await import(`./network/${file}`);
            return plugin.default;
        }));

        return networks.filter(network => network && network.name);
    }

    async selectNetwork(networkPlugins) {
        // Sort networks by usage count (descending)
        const sortedNetworks = networkPlugins.sort((a, b) =>
            (this.networkUsage[b.name] || 0) - (this.networkUsage[a.name] || 0)
        );

        const { network } = await inquirer.prompt({
            type: 'list',
            name: 'network',
            message: 'Select the network:',
            choices: sortedNetworks.map(plugin => plugin.name),
        });

        const selectedNetwork = sortedNetworks.find(plugin => plugin.name === network);

        // Increment usage count for the selected network
        this.networkUsage[network] = (this.networkUsage[network] || 0) + 1;
        this.db.set('networkUsage', this.networkUsage);

        this.selectedNetwork = selectedNetwork;
    }

    async loadAccount(loggedIn = false) {
        let account = this.getAccount();

        const mainChoices = ['Create New Account'];

        if (loggedIn) {
            mainChoices.push('Import Options');
            mainChoices.push('Export Options');
            mainChoices.push('Switch Network');
            mainChoices.push('Go Back');
        } else {
            mainChoices.push('Import Mnemonic (12 words)');
            mainChoices.push('Import Private-key');
            mainChoices.push('Import HODL File');
        }

        if (!account || loggedIn) {
            let { accountAction } = await inquirer.prompt({
                type: 'list',
                name: 'accountAction',
                message: 'Select an account option:',
                choices: mainChoices,
            });

            if (accountAction === 'Go Back') {
                return;
            }

            if (accountAction === 'Import Options') {
                const importChoices = ['Import Mnemonic (12 words)', 'Import Private-key', 'Import HODL File', 'Go Back'];
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
                case 'Import Mnemonic (12 words)':
                    account = await this.importFromMnemonic();
                    if (!account) {
                        // Wallet.displayError('Invalid mnemonic.');
                        return;
                    }
                    this.setAccount(account);
                    this.displayAccountAddress();
                    break;
                case 'Import Private-key':
                    await this.importPrivateKey();
                    break;
                case 'Import HODL File':
                    this.setAccount(await this.importHODLFile());
                    this.displayAccountAddress();
                    break;
            }

            if (accountAction === 'Export Options') {
                const exportChoices = ['Export Private-key', 'Export HODL File', 'Go Back'];
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

        this.setAccount(account);
    }

    async confirmOverwrite() {
        if (this.getAccount()) {
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

    async importFromMnemonic() {
        const { mnemonic } = await inquirer.prompt({
            type: 'password',
            name: 'mnemonic',
            message: 'Enter your 12-word mnemonic phrase:',
            mask: '*',
            validate: (input) => {
                if (input.trim() === '') return true;
                return this.network.validateMnemonic(input) || 'Please enter a valid mnemonic phrase or leave empty to cancel.';
            }
        });

        if (!mnemonic.trim()) return null;

        return this.network.accountFromMnemonic(mnemonic);
    }

    async showBalance() {
        if (!this.getAccount()) {
            Wallet.displayError('Account not initialized.');
            return;
        }

        const balances = await this.network.getTokenBalances(this.getAddress());

        const table = new Table({
            head: ['Token', 'Balance'],
            style: { head: ['blue'] },
            colWidths: [21, 22]
        });

        balances.forEach(([token, balance]) => {
            table.push([token, balance.toFixed(3)]);
        });

        console.log(table.toString());
    }

    async transferFunds() {
        const contacts = this.db.get('contact', this.network.name) || {};
        const addressBook = Object.entries(contacts).map(([address, data]) => ({
            address,
            name: data.name
        }));

        addressBook.push({ name: 'Go Back', address: '' });

        // Implement autocomplete for address book
        const { recipient } = await inquirer.prompt({
            type: 'autocomplete',
            name: 'recipient',
            message: 'Recipient address:',
            source: (answersSoFar, input) => {
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
            message: `Amount to transfer:`,
            validate: value => {
                if (value.trim() === '') return true;
                return !isNaN(value) && Number(value) > 0 ? true : 'Please enter a valid number or leave empty to cancel.';
            },
        });

        if (amount.trim() === '') {
            return;
        }

        // Add confirmation step
        const { confirmTransaction } = await inquirer.prompt({
            type: 'confirm',
            name: 'confirmTransaction',
            message: `Confirm transfer?`,
            default: true
        });

        if (!confirmTransaction) {
            return;
        }

        const spinner = ora({
            text: 'Sending transaction...',
            spinner: 'dots'
        }).start();

        try {
            let signedTx;
            if (token === this.selectedNetwork.nativeToken) {
                signedTx = await this.network.handleNativeTransfer(this.getAccount(), address, amount);
            } else {
                signedTx = await this.network.handleERC20Transfer(this.getAccount(), token, address, amount);
            }

            const receipt = await this.network.sendSignedTransaction(signedTx);

            spinner.succeed('Transaction confirmed!');

            this.displayTransactionResult(address, token, amount, receipt.transactionHash);

            // Add transaction to history
            this.addToTransactions(address, token, amount, receipt.transactionHash);

            if (!contacts[address]) {
                await this.addToAddressBook(address);
            }

        } catch (error) {
            spinner.fail('Transaction failed');
            this.displayTransactionError(error);
        }
    }

    displayTransactionError(error) {
        const data = error.reason ? error.reason.replace(/(\w+):/g, "\n$1:").trim() : null;
        Wallet.displayError(error.message, data);
    }

    static displayError(message, data) {
        const table = new Table({
            head: [message],
            style: { head: ['red'] },
            wordWrap: true,
        });

        if (data) {
            table.push([data.toString()]);
        }

        console.log(table.toString());
    }

    formatDate(date) {
        return new Date(date).toLocaleString('en-GB', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1').replace(",", "");
    }

    addToTransactions(recipient, token, amount, hash) {
        const transaction = {
            timestamp: new Date().toISOString(),
            recipient,
            token,
            amount,
            hash
        };
        this.db.add('transactions', this.getAddress(), this.selectedNetwork.nativeToken, transaction);
    }

    async showTransactions() {
        const history = this.db.values('transactions', this.getAddress(), this.selectedNetwork.nativeToken) || [];

        const table = new Table({
            head: ['Date', 'Recipient', 'Token', 'Amount'],
            style: { head: ['blue'] },
        });

        if (history.length === 0) {
            table.push([{ colSpan: 4, content: 'No transaction history available.' }]);
        }

        history.forEach(tx => {
            const date = this.formatDate(tx.timestamp);
            const contact = this.db.get('contact', this.network.name, tx.recipient);
            const recipient = contact ? `${tx.recipient} (${contact.name})` : tx.recipient;
            const amount = parseFloat(tx.amount).toFixed(3);
            table.push([date, recipient, tx.token, amount]);
            table.push([{ colSpan: 4, content: this.selectedNetwork.explorer + tx.hash }]);
        });

        console.log(table.toString());
    }

    async addToAddressBook(address) {
        const { name } = await inquirer.prompt({
            type: 'input',
            name: 'name',
            message: 'Name for the address book (leave empty to skip):',
        });

        if (name.trim() !== '') {

            this.db.set('contact', this.network.name, address, 'name', name);

            const table = new Table({
                head: [{ colSpan: 2, content: "Recipient saved to the address book." }],
                style: { head: ['green'] },
            });

            table.push([name, address]);
            console.log(table.toString());
        }
    }

    displayTransactionResult(address, token, amount, hash) {

        const table = new Table({
            head: ['Date', 'Recipient', 'Token', 'Amount'],
            style: { head: ['green'] },
        });

        const date = this.formatDate(new Date());

        const contact = this.db.get('contact', this.network.name, address);
        const recipient = contact ? `${address} (${contact.name})` : address;

        table.push([date, recipient, token, parseFloat(amount).toFixed(3)]);
        table.push([{ colSpan: 4, content: this.selectedNetwork.explorer + hash }]);

        console.log(table.toString());
    }

    clearAccountData() {

    }

    displayAccountDetails() {

        const table = new Table({
            head: [{ colSpan: 2, content: 'Account Details' }],
            style: { head: ['green'] },
            wordWrap: true
        });

        table.push(
            ['Address', this.getAddress()],
            ['Private-key', this.getAccount().privateKey]
        );

        const mnemonic = this.getMnemonic();
        if (mnemonic) {
            table.push(['Mnemonic Phrase', mnemonic]);
            table.push(['WARNING', "Please keep your private-key and mnemonic phrase secure. Never share it."]);
        } else {
            table.push(['WARNING', "Please keep your private-key secure. Never share it."]);
        }

        console.log(table.toString());
    }

    async switchNetwork() {
        const networkPlugins = await this.loadNetworkPlugins();
        await this.selectNetwork(networkPlugins);
        this.network = new this.selectedNetwork.NetworkClass(this.selectedNetwork);
        this.displayAccountAddress();
    }

    async exportHODLFile() {
        const defaultFileName = `${this.getAddress().slice(-6).toUpperCase()}`;
        let { fileName } = await inquirer.prompt({
            type: 'input',
            name: 'fileName',
            message: 'Enter the name for the HODL file:',
            default: defaultFileName
        });

        fileName += '.HODL';

        const data = this.db.get();
        const encryptionKey = await UIManager.getEncryptionKey();
        const encryptedData = Persist.encrypt(data, encryptionKey);

        fs.writeFileSync(fileName, encryptedData);

        const table = new Table({
            head: ['HODL File Exported'],
            style: { head: ['green'] }
        });
        table.push([`File saved as: ${fileName}`]);
        console.log(table.toString());
    }

    async importHODLFile() {
        const { filePath } = await inquirer.prompt({
            type: 'fuzzypath',
            name: 'filePath',
            message: 'Select the .HODL file:',
            rootPath: '.',
            itemType: 'file',
            suggestOnly: false,
            depthLimit: 5,
            excludePath: nodePath => nodePath.startsWith('node_modules'),
            excludeFilter: nodePath => !nodePath.endsWith('.HODL'),
        });

        if (!fs.existsSync(filePath)) {
            Wallet.displayError('File not found.');
            return;
        }

        const encryptedData = fs.readFileSync(filePath, 'utf8');
        const encryptionKey = await UIManager.getEncryptionKey();

        try {
            this.db.set(Persist.decrypt(encryptedData, encryptionKey));
            return this.getAccount();
        } catch (error) {
            Wallet.displayError('Failed to import HODL file.', 'The password is incorrect.');
        }
    }

    async importPrivateKey() {
        const { privateKey } = await inquirer.prompt({
            type: 'password',
            name: 'privateKey',
            message: 'Private-key (leave empty to cancel):',
            mask: '*',
            validate: (input) => {
                if (input.trim() === '') return true;
                return /^(0x)?[0-9a-fA-F]{64}$/.test(input) || 'Please enter a valid private-key or leave empty to cancel.';
            }
        });

        if (!privateKey.trim()) {
            return;  // Silently return if empty
        }

        try {
            this.setAccount(await this.network.privateKeyToAccount(privateKey));
            this.displayAccountAddress();
        } catch (error) {
            Wallet.displayError('Invalid private-key.');
        }
    }

    async createNewAccount() {
        let existingMnemonic = this.getMnemonic();
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
                this.setAccount(await this.network.accountFromMnemonic(existingMnemonic));
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
                this.setAccount(await this.network.createAccountFromMnemonic());
            } else {
                this.setAccount(await this.network.createAccount());
            }
        }

        let message = 'Do you want to display sensitive information (private key';
        if (this.getMnemonic()) {
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
            this.displayAccountDetails();
        } else {
            this.displayAccountAddress();
        }
    }
}

class UIManager {
    static displayWelcome() {
        console.log('\x1b[32m');  // Set text color to green
        console.log(` ░░░░░░░░░░░░░░ █ █ █▀█ █▀▄ █   ░░░░░░░░░░░░░░
 ░░░░░░░░░░░░░░ █▀█ █▄█ █▄▀ █▄▄ ░░░░░░░░░░░░░░
 ░░░░░░░░░░░░░░ ──────── WALLET ░░░░░░░░░░░░░░`);
        console.log('\x1b[0m');  // Reset text color
    }

    static async getEncryptionKey() {
        const { key } = await inquirer.prompt({
            type: 'password',
            name: 'key',
            message: 'Password:',
            mask: '*',
        });
        return key;
    }

    static async confirmEncryptionKey(originalKey) {
        const { confirmKey } = await inquirer.prompt({
            type: 'password',
            name: 'confirmKey',
            message: 'Repeat Password:',
            mask: '*',
        });
        return confirmKey;
    }

    static displayExitPhrase() {
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

        const table = new Table({
            head: ['✨ Good bye!'],
            style: { head: ['yellow'] },
            wordWrap: true,
        });

        table.push([randomPhrase]);

        console.log(table.toString());
    }
}

UIManager.displayWelcome();
const encryptionKey = await UIManager.getEncryptionKey();
let wallet;

try {
    wallet = new Wallet(encryptionKey);
} catch (error) {
    console.error(error.message);
    Wallet.displayError('Wrong password.');
    process.exit(1);
}

const accountExists = wallet.getMnemonic();

if (!accountExists) {
    const confirmedKey = await UIManager.confirmEncryptionKey(encryptionKey);
    if (confirmedKey !== encryptionKey) {
        Wallet.displayError('Passwords do not match. Please try again.');
        process.exit(1);
    }
}

try {
    await wallet.initialize();
    if (accountExists) wallet.displayAccountAddress();
} catch (error) {
    Wallet.displayError('Failed to initialize wallet.', error);
    process.exit(1);
}

process.on('exit', () => {
    wallet.clearAccountData();
    UIManager.displayExitPhrase();
});

while (true) {
    const { action } = await inquirer.prompt({
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
            { name: 'Transfer Funds', value: 'transferFunds' },
            { name: 'Show Balance', value: 'balance' },
            { name: 'Show Sent Transfers', value: 'showTransactions' },
            { name: 'Account Settings', value: 'account' },
            { name: 'Exit', value: 'exit' }
        ],
    });

    switch (action) {
        case 'transferFunds':
            await wallet.transferFunds();
            break;
        case 'balance':
            await wallet.showBalance();
            break;
        case 'showTransactions':
            await wallet.showTransactions();
            break;
        case 'account':
            await wallet.loadAccount(true);
            break;
        case 'exit':
            process.exit();
    }
}
