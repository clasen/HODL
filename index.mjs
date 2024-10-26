#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import Web3 from 'web3';
import inquirer from 'inquirer';
import Persist from './persist.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Table from 'cli-table3';
import bip39 from 'bip39';
import hdkey from 'hdkey';
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
        this.web3 = null;
        this.selectedNetwork = null;
        this.account = null;
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
            this.web3 = new Web3(this.selectedNetwork.rpcUrl);
            await this.loadAccount();

            if (!this.account) {
                Wallet.displayError('Failed to initialize account.');
                process.exit(1);
            }

        } catch (error) {
            Wallet.displayError('Initialization failed', error);
            process.exit(1);
        }
    }

    displayAccountAddress() {
        const table = new Table({
            head: ['Account Address'],
            style: {
                head: ['green']
            }
        });
        table.push([this.account.address]);
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

    async loadAccount(forceReload = false) {
        let account = this.db.secureGet('account');

        const mainChoices = ['Create New Account'];

        if (forceReload) {
            mainChoices.push('Import Options');
            mainChoices.push('Export Options');
            mainChoices.push('Switch Network');
            mainChoices.push('Go Back');
        } else {
            mainChoices.push('Import Mnemonic (12 words)');
            mainChoices.push('Import Private-key');
            mainChoices.push('Import HODL File');
        }

        if (!account || forceReload) {
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
                    return this.loadAccount(forceReload);
                }

                if (!await this.confirmOverwrite()) {
                    return;
                }

                accountAction = importAction;
            }

            switch (accountAction) {
                case 'Import Mnemonic (12 words)':
                    account = await this.importFrom12Words();
                    if (!account) {
                        Wallet.displayError('Invalid mnemonic.');
                        return;
                    }
                    this.account = account;
                    this.displayAccountAddress();
                    break;
                case 'Import Private-key':
                    await this.importPrivateKey();
                    break;
                case 'Import HODL File':
                    this.account = await this.importHODLFile();
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
                    return this.loadAccount(forceReload);
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
                if (!await this.confirmOverwrite()) {
                    return;
                }

                await this.createNewAccount();
            }

            if (accountAction === 'Switch Network') {
                await this.switchNetwork();
            }

            return;
        }

        this.account = account;
    }

    async confirmOverwrite() {
        if (this.account) {
            const { confirmOverwrite } = await inquirer.prompt({
                type: 'confirm',
                name: 'confirmOverwrite',
                message: 'This action will overwrite the existing account. Are you sure you want to continue?',
                default: false,
            });

            return confirmOverwrite;
        }
        return false;
    }

    async importFrom12Words() {
        const { mnemonic } = await inquirer.prompt({
            type: 'password',
            name: 'mnemonic',
            message: 'Enter your 12-word mnemonic phrase:',
            mask: '*',
        });

        if (!bip39.validateMnemonic(mnemonic)) {
            return null;
        }

        const account = await this.accountFromMnemonic(mnemonic);
        await this.db.secureSet('account', account);
        return account;
    }

    async showBalance() {
        if (!this.account) {
            Wallet.displayError('Account not initialized.', 'Ï Please try restarting the application.');
            return;
        }

        const balanceWei = await this.web3.eth.getBalance(this.account.address);
        const balance = Web3.utils.fromWei(balanceWei, 'ether');

        const table = new Table({
            head: ['Token', 'Balance'],
            style: { head: ['blue'] },
            colWidths: [21, 22]
        });

        // table.push([{ colSpan: 2, content: this.account.address }]);
        table.push([this.selectedNetwork.nativeToken, parseFloat(balance).toFixed(3)]);

        // Check if USDT is available on the selected network
        if (this.selectedNetwork.tokens['USDT']) {
            const usdtAddress = this.selectedNetwork.tokens['USDT'];
            const ERC20_ABI = [
                {
                    constant: true,
                    inputs: [{ name: "_owner", type: "address" }],
                    name: "balanceOf",
                    outputs: [{ name: "balance", type: "uint256" }],
                    type: "function"
                },
                {
                    constant: true,
                    inputs: [],
                    name: "decimals",
                    outputs: [{ name: "", type: "uint8" }],
                    type: "function"
                }
            ];

            const usdtContract = new this.web3.eth.Contract(ERC20_ABI, usdtAddress);
            const usdtBalance = await usdtContract.methods.balanceOf(this.account.address).call();
            const decimals = await usdtContract.methods.decimals().call();

            // Fixed calculation using BigInt consistently
            const formattedUsdtBalance = Number(
                (BigInt(usdtBalance) * 100n) / (10n ** BigInt(decimals))
            ) / 100;

            table.push(['USDT', formattedUsdtBalance.toFixed(3)]);
        }

        console.log(table.toString());
    }

    async transferFunds() {
        const contacts = this.db.get('contact') || {};
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

        const { token } = await inquirer.prompt({
            type: 'list',
            name: 'token',
            message: 'Token to transfer:',
            choices: Object.keys(this.selectedNetwork.tokens),
        });

        const tokens = this.selectedNetwork.tokens;

        const { amount } = await inquirer.prompt({
            type: 'input',
            name: 'amount',
            message: `Amount to transfer:`,
            validate: value => {
                if (value === '') return true;
                return !isNaN(value) && Number(value) > 0 ? true : 'Please enter a valid number or leave empty to cancel.';
            },
        });

        if (amount === '') {
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
            if (tokens[token] && token !== this.selectedNetwork.nativeToken) {
                signedTx = await this.handleERC20Transfer(token, address, amount);
            } else {
                signedTx = await this.handleNativeTransfer(address, amount);
            }

            const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            
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
            table.push([data]);
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
        this.db.add('transactions', this.account.address, this.selectedNetwork.nativeToken, transaction);
    }

    async showTransactions() {
        const history = this.db.values('transactions', this.account.address, this.selectedNetwork.nativeToken) || [];

        const table = new Table({
            head: ['Date', 'Recipient', 'Token', 'Amount'],
            style: { head: ['blue'] },
        });

        if (history.length === 0) {
            table.push([{ colSpan: 4, content: 'No transaction history available.' }]);
        }

        history.forEach(tx => {
            const date = this.formatDate(tx.timestamp);
            const contact = this.db.get('contact', tx.recipient);
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

            this.db.set('contact', address, 'name', name);

            const table = new Table({
                head: [{ colSpan: 2, content: "Recipient saved to the address book." }],
                style: { head: ['green'] },
            });

            table.push([name, address]);
            console.log(table.toString());
        }
    }

    async handleERC20Transfer(token, recipient, amount) {
        const ERC20_ABI = [
            // Minimal ABI to interact with ERC20 tokens
            {
                constant: true,
                name: 'decimals',
                inputs: [],
                outputs: [{ name: '', type: 'uint8' }],
                type: 'function',
            },
            {
                constant: false,
                name: 'transfer',
                inputs: [
                    { name: '_to', type: 'address' },
                    { name: '_value', type: 'uint256' },
                ],
                outputs: [{ name: '', type: 'bool' }],
                type: 'function',
            },
        ];

        const contract = new this.web3.eth.Contract(ERC20_ABI, this.selectedNetwork.tokens[token]);
        const decimals = parseInt(await contract.methods.decimals().call(), 10);

        const weiAmount = BigInt(this.web3.utils.toWei(amount, 'ether'));
        const adjustedAmount = weiAmount / (10n ** BigInt(18 - decimals));

        try {
            const data = contract.methods.transfer(recipient, adjustedAmount.toString()).encodeABI();
            const gasLimit = 100000;
            const gasPrice = await this.web3.eth.getGasPrice();

            const tx = {
                from: this.account.address,
                to: this.selectedNetwork.tokens[token],
                data: data,
                gas: gasLimit,
                gasPrice: gasPrice,
            };

            return this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
        } catch (error) {
            this.displayTransactionError(error);
        }
    }

    async handleNativeTransfer(recipient, amount) {
        const gasPrice = await this.web3.eth.getGasPrice();
        const gasLimit = 21000; // Gas estándar para una transacción simple
        const gasCost = BigInt(gasPrice) * BigInt(gasLimit);
        let amountWei = BigInt(this.web3.utils.toWei(amount, 'ether'));

        // Obtener el balance actual
        const balance = BigInt(await this.web3.eth.getBalance(this.account.address));

        if (balance < amountWei + gasCost) {
            amountWei -= gasCost;
        }

        if (balance < amountWei + gasCost) {
            const maxAmount = this.web3.utils.fromWei((balance - gasCost).toString(), 'ether');
            const table = new Table({
                head: [{ colSpan: 2, content: 'Insufficient balance for this transaction.' }],
                style: { head: ['red'] },
                wordWrap: true
            });
            table.push(['Maximum Amount', `${maxAmount} ${this.selectedNetwork.nativeToken}`]);
            console.log(table.toString());
        }

        const tx = {
            from: this.account.address,
            to: recipient,
            value: amountWei.toString(),
            gas: gasLimit,
            gasPrice: gasPrice
        };

        return this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
    }

    displayTransactionResult(address, token, amount, hash) {

        const table = new Table({
            head: ['Date', 'Recipient', 'Token', 'Amount'],
            style: { head: ['green'] },
        });

        const date = this.formatDate(new Date());

        const contact = this.db.get('contact', address);
        const recipient = contact ? `${address} (${contact.name})` : address;

        table.push([date, recipient, token, parseFloat(amount).toFixed(3)]);
        table.push([{ colSpan: 4, content: this.selectedNetwork.explorer + hash }]);

        console.log(table.toString());
    }

    clearAccountData() {
        if (this.account) {
            this.account.privateKey = '0'.repeat(64);
            this.account.mnemonic = 'x'.repeat(256);
            this.account = null;
        }
    }

    displayAccountDetails() {

        const table = new Table({
            head: [{ colSpan: 2, content: 'Account Details' }],
            style: { head: ['green'] },
            wordWrap: true
        });

        table.push(
            ['Address', this.account.address],
            ['Private-key', this.account.privateKey]
        );

        if (this.account.mnemonic) {
            table.push(['Mnemonic Phrase', this.account.mnemonic]);
            table.push(['WARNING', "Please keep your private-key and mnemonic phrase secure. Never share it."]);
        } else {
            table.push(['WARNING', "Please keep your private-key secure. Never share it."]);
        }

        console.log(table.toString());
    }

    async switchNetwork() {
        const networkPlugins = await this.loadNetworkPlugins();
        await this.selectNetwork(networkPlugins);
        this.web3 = new Web3(this.selectedNetwork.rpcUrl);
    }

    async exportHODLFile() {
        const defaultFileName = `${this.account.address.slice(-6).toUpperCase()}`;
        let { fileName } = await inquirer.prompt({
            type: 'input',
            name: 'fileName',
            message: 'Enter the name for the HODL file:',
            default: defaultFileName
        });

        fileName += '.HODL';

        const data = this.db.get();
        const encryptedData = this.db.encrypt(data);

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

        try {
            const decryptedData = this.db.decrypt(encryptedData);
            this.db.set(decryptedData);
            return this.db.secureGet('account');
        } catch (error) {
            Wallet.displayError('Failed to import HODL file.', 'The file may be corrupted or the encryption key is incorrect.');
        }
    }

    async importPrivateKey() {
        const { privateKey } = await inquirer.prompt({
            type: 'password',
            name: 'privateKey',
            message: 'Private-key:',
            mask: '*',
        });

        if (!privateKey.trim()) {
            Wallet.displayError('Private-key is empty.');
            return;
        }

        try {
            this.account = this.web3.eth.accounts.privateKeyToAccount(privateKey);
            await this.db.secureSet('account', this.account);
            this.displayAccountAddress();
        } catch (error) {
            Wallet.displayError('Invalid private-key.');
        }
    }

    async createNewAccount() {
        const { createWithMnemonic } = await inquirer.prompt({
            type: 'confirm',
            name: 'createWithMnemonic',
            message: 'Create account with mnemonic?',
            default: true
        });

        let message = 'Do you want to display sensitive information (private key';
        if (createWithMnemonic) {
            this.account = await this.createAccountFromMnemonic();
            message += ' and mnemonic';
        } else {
            this.account = this.web3.eth.accounts.create();
        }

        message += ')?';

        await this.db.secureSet('account', this.account);

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

    async accountFromMnemonic(mnemonic) {
        const seed = await bip39.mnemonicToSeed(mnemonic);
        const root = hdkey.fromMasterSeed(seed);
        const addrNode = root.derive("m/44'/60'/0'/0/0");
        const privateKey = addrNode.privateKey.toString('hex');
        const account = this.web3.eth.accounts.privateKeyToAccount('0x' + privateKey);
        account.mnemonic = mnemonic;
        return account;
    }

    async createAccountFromMnemonic() {
        try {
            const mnemonic = bip39.generateMnemonic();
            return this.accountFromMnemonic(mnemonic);
        } catch (error) {
            Wallet.displayError('Failed to create account from mnemonic.', error);
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
const wallet = new Wallet(encryptionKey);

// Check if an account exists
const accountExists = wallet.db.secureGet('account');
if (accountExists === null) {
    Wallet.displayError('Wrong password.');
    process.exit(1);
}

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
        case 'balance':
            await wallet.showBalance();
            break;
        case 'transferFunds':
            await wallet.transferFunds();
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
