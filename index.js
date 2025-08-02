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
        this.networkUsage = {};
    }

    formatAmount(num) {
        num = parseFloat(num);
        const numStr = num.toString();

        if (!numStr.includes('.')) {
          // No decimal point; append '.00'
          return numStr + '.00';
        }
      
        const decimalPart = numStr.split('.')[1];
        const decimalLength = decimalPart.length;
      
        if (decimalLength === 1) {
          // One decimal digit; append '0'
          return num.toFixed(2);
        }
      
        // More than one decimal digit; round to 3 decimal places if needed
        return decimalLength > 3 ? num.toFixed(3) : numStr;
    }

    async initialize() {
        try {
            this.networkUsage = await this.db.get('networkUsage') || {};

            const networkPlugins = await this.loadNetworkPlugins();
            if (networkPlugins.length === 0) {
                Wallet.displayError('No valid network plugins found.');
                process.exit(1);
            }
            await this.selectNetwork(networkPlugins, { autoSelect: true });
            this.network = new this.selectedNetwork.NetworkClass(this.selectedNetwork);
            this.network.name = this.selectedNetwork.name;

            await this.loadAccount();
            const account = await this.getAccount();

            if (!account) {
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

    async getAccount() {
        const account = this.db.get('account', this.network.constructor.name);
        
        
        return account;
    }

    async getAddress() {
        return this.db.get('account', this.network.constructor.name, 'address');
    }

    async getMnemonic() {
        return this.db.get('mnemonic');
    }

    async displayAccountAddress() {

        const table = new Table({
            head: [`${this.selectedNetwork.name} Address`],
            style: {
                head: ['green']
            }
        });
        
        table.push([await this.getAddress()]);
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

    async selectNetwork(networkPlugins, { autoSelect = false } = {}) {
        // Sort networks by last used timestamp (most recent first)
        const sortedNetworks = networkPlugins.sort((a, b) => {
            const aUsage = this.networkUsage[a.name];
            const bUsage = this.networkUsage[b.name];
            
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

        let selectedNetwork;

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

        // Update usage info for the selected network
        // Handle migration from old format (number) to new format (object)
        const currentUsage = this.networkUsage[selectedNetwork.name];
        
        if (!currentUsage || typeof currentUsage === 'number') {
            // Old format (number) or doesn't exist - create new object
            this.networkUsage[selectedNetwork.name] = { 
                count: typeof currentUsage === 'number' ? currentUsage + 1 : 1, 
                lastUsed: Date.now() 
            };
        } else {
            // New format (object) - update values
            this.networkUsage[selectedNetwork.name].count = (currentUsage.count || 0) + 1;
            this.networkUsage[selectedNetwork.name].lastUsed = Date.now();
        }
        
        await this.db.set('networkUsage', this.networkUsage);

        this.selectedNetwork = selectedNetwork;
    }

    async loadAccount(loggedIn = false) {
        let account = await this.getAccount();

        const mainChoices = ['Create New Account'];

        if (loggedIn) {
            mainChoices.push('Import Options');
            mainChoices.push('Export Options');
            mainChoices.push('Switch Network');
            mainChoices.push('Manage Address Book');
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
                    await this.displayAccountAddress();
                    break;
                case 'Import Private-key':
                    await this.importPrivateKey();
                    break;
                case 'Import HODL File':
                    this.setAccount(await this.importHODLFile());
                    await this.displayAccountAddress();
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
        if (await this.getAccount()) {
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
        const account = await this.getAccount();

        if (!account) {
            Wallet.displayError('Account not initialized.');
            return;
        }

        const balances = await this.network.getTokenBalances(await this.getAddress());

        const table = new Table({
            head: ['Token', 'Balance'],
            style: { head: ['blue'] },
            colWidths: [21, 22]
        });

        balances.forEach(([token, balance]) => {
            table.push([token, this.formatAmount(balance)]);
        });

        console.log(table.toString());
    }

    async transferFunds() {
        const contacts = await this.db.entries('contact', this.network.name) || [];
        const addressBook = contacts.map(([address, data]) => ({
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
            const account = await this.getAccount();
            if (token === this.selectedNetwork.nativeToken) {
                signedTx = await this.network.handleNativeTransfer(account, address, amount);
            } else {
                signedTx = await this.network.handleERC20Transfer(account, token, address, amount);
            }

            const receipt = await this.network.sendSignedTransaction(signedTx);

            spinner.succeed('Transaction confirmed!');

            const transactionHash = receipt?.transactionHash || receipt?.hash || 'UNKNOWN_HASH';

            // Get current balance after transfer
            let currentBalance = 0;
            try {
                const walletAddress = await this.getAddress();
                if (token === this.selectedNetwork.nativeToken) {
                    currentBalance = await this.network.getBalance(walletAddress);
                } else {
                    currentBalance = await this.network.getTokenBalance(walletAddress, token);
                }
            } catch (error) {
                console.error('Error getting current balance:', error.message);
            }

            await this.displayTransactionResult(address, token, amount, transactionHash, currentBalance);

            // Add transaction to history
            await this.addToTransactions(address, token, amount, transactionHash, currentBalance);

            // Check if the address is already in contacts before asking to add it
            const existingContact = await this.db.get('contact', this.network.name, address);
            if (!existingContact) {
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

    async addToTransactions(recipient, token, amount, hash, balance) {
        const transaction = {
            timestamp: new Date().toISOString(),
            recipient,
            token,
            amount,
            hash,
            balance
        };
        const address = await this.getAddress();
        this.db.add('transactions', address, this.selectedNetwork.nativeToken, transaction);
    }

    async showTransactions() {
        const address = await this.getAddress();
        const history = await this.db.values('transactions', address, this.selectedNetwork.nativeToken) || [];

        const table = new Table({
            head: ['Date', 'Recipient', 'Token', 'Amount', 'Balance'],
            style: { head: ['blue'] },
        });

        if (history.length === 0) {
            table.push([{ colSpan: 5, content: 'No transaction history available.' }]);
        }

        for (const tx of history) {
            const date = this.formatDate(tx.timestamp);
            const contact = await this.db.get('contact', this.network.name, tx.recipient);
            const recipient = contact ? `${tx.recipient} (${contact.name})` : tx.recipient;
            const amount = this.formatAmount(tx.amount);
            const balance = tx.balance !== undefined ? this.formatAmount(tx.balance) : '-';
            table.push([date, recipient, tx.token, amount, balance]);
            table.push([{ colSpan: 5, content: this.selectedNetwork.explorer + tx.hash }]);
        }

        console.log(table.toString());
    }

    async addToAddressBook(address) {
        const { name } = await inquirer.prompt({
            type: 'input',
            name: 'name',
            message: 'Name for the address book (leave empty to skip):',
        });

        if (name.trim() !== '') {
            await this.db.set('contact', this.network.name, address, 'name', name);

            const table = new Table({
                head: [{ colSpan: 2, content: "Recipient saved to the address book." }],
                style: { head: ['green'] },
            });

            table.push([name, address]);
            console.log(table.toString());
        }
    }

    async deleteFromAddressBook() {
        const contacts = await this.db.get('contact', this.network.name) || {};
        const addressBook = Object.entries(contacts).map(([address, data]) => ({
            address,
            name: data.name
        }));

        if (addressBook.length === 0) {
            const table = new Table({
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
            await this.db.del('contact', this.network.name, addressToDelete);
            const table = new Table({
                head: ['Address Book'],
                style: { head: ['green'] },
            });
            table.push(['Address deleted successfully.']);
            console.log(table.toString());
        }
    }

    async displayTransactionResult(address, token, amount, hash, balance) {
        const table = new Table({
            head: ['Date', 'Recipient', 'Token', 'Amount', 'Balance'],
            style: { head: ['green'] },
        });

        const date = this.formatDate(new Date());

        const contact = await this.db.get('contact', this.network.name, address);
        const recipient = contact ? `${address} (${contact.name})` : address;

        table.push([date, recipient, token, this.formatAmount(amount), this.formatAmount(balance)]);
        table.push([{ colSpan: 5, content: this.selectedNetwork.explorer + hash }]);

        console.log(table.toString());
    }

    clearAccountData() {

    }

    async displayAccountDetails() {

        const table = new Table({
            head: [{ colSpan: 2, content: 'Account Details' }],
            style: { head: ['green'] },
            wordWrap: true
        });

        const account = await this.getAccount();
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
    }

    async switchNetwork() {
        const networkPlugins = await this.loadNetworkPlugins();
        await this.selectNetwork(networkPlugins);
        this.network = new this.selectedNetwork.NetworkClass(this.selectedNetwork);
        this.network.name = this.selectedNetwork.name;

        const account = await this.getAccount();
        if (account) {
            await this.displayAccountAddress();
        } else {
            console.log(`\nNo account found for ${this.selectedNetwork.name}. Please create or import an account.`);
            await this.loadAccount(true);
        }
    }

    async exportHODLFile() {
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
            await this.displayAccountAddress();
        } catch (error) {
            Wallet.displayError('Invalid private-key.');
        }
    }

    async createNewAccount() {
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

        // Check if there are addresses in the address book
        const addressBook = await this.db.entries('contact', this.network.name) || [];

        if (addressBook.length > 0) {
            const { deleteAddresses } = await inquirer.prompt({
                type: 'confirm',
                name: 'deleteAddresses',
                message: `Do you want to delete all ${addressBook.length} addresses from the previous account?`,
                default: false
            });

            if (deleteAddresses) {

                await this.db.del('contact');

                const table = new Table({
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

    static async confirmEncryptionKey() {
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

const accountExists = await wallet.getMnemonic();

if (!accountExists) {
    const confirmedKey = await UIManager.confirmEncryptionKey();
    if (confirmedKey !== encryptionKey) {
        Wallet.displayError('Passwords do not match. Please try again.');
        process.exit(1);
    }
}

try {
    await wallet.initialize();
    if (accountExists) await wallet.displayAccountAddress();
} catch (error) {
    Wallet.displayError('Failed to initialize wallet.', error);
    process.exit(1);
}

process.on('exit', () => {
    wallet.clearAccountData();
    UIManager.displayExitPhrase();
});

async function mainMenu() {
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
            return mainMenu();
        case 'balance':
            await wallet.showBalance();
            return mainMenu();
        case 'showTransactions':
            await wallet.showTransactions();
            return mainMenu();
        case 'account':
            await wallet.loadAccount(true);
            return mainMenu();
        case 'exit':
            process.exit();
    }
}

// Start the application
mainMenu();
