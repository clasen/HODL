// wallet.js
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import inquirerAutocomplete from 'inquirer-autocomplete-prompt';
inquirer.registerPrompt('autocomplete', inquirerAutocomplete);

class Wallet {
    constructor(encryptionKey) {
        this.db = new Persist(encryptionKey);
        this.web3 = null;
        this.selectedNetwork = null;
        this.account = null;
    }

    async initialize() {
        try {
            const networkPlugins = await this.loadNetworkPlugins();
            if (networkPlugins.length === 0) {
                console.log('No valid network plugins found.');
                process.exit(1);
            }
            await this.selectNetwork(networkPlugins);
            this.web3 = new Web3(this.selectedNetwork.rpcUrl);
            await this.loadAccount();

            if (!this.account) {
                throw new Error('Failed to initialize account');
            }

        } catch (error) {
            console.error('Initialization failed:', error);
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
        const { network } = await inquirer.prompt({
            type: 'list',
            name: 'network',
            message: 'Select the network:',
            choices: networkPlugins.map(plugin => plugin.name),
        });

        const selectedNetwork = networkPlugins.find(plugin => plugin.name === network);

        this.selectedNetwork = selectedNetwork;
    }

    async loadAccount(forceReload = false) {
        let account = this.db.secureGet('account');

        if (!account || forceReload) {
            const { accountAction } = await inquirer.prompt({
                type: 'list',
                name: 'accountAction',
                message: 'Select an account option:',
                choices: ['Import private key', 'Import from 12 words', 'Create new account'],
            });

            if (accountAction === 'Import private key') {
                const { privateKey } = await inquirer.prompt({
                    type: 'password',
                    name: 'privateKey',
                    message: 'Private key:',
                    mask: '*',
                });
                account = this.web3.eth.accounts.privateKeyToAccount(privateKey);
                await this.db.secureSet('account', { privateKey: account.privateKey });

                this.account = account;
                this.displayAccountAddress();
            } else if (accountAction === 'Import from 12 words') {
                account = await this.importFrom12Words();
                this.account = account;
                this.displayAccountAddress();
            } else {
                const mnemonic = bip39.generateMnemonic();
                const seed = await bip39.mnemonicToSeed(mnemonic);
                const root = hdkey.fromMasterSeed(seed);
                const addrNode = root.derive("m/44'/60'/0'/0/0");
                const privateKey = addrNode.privateKey.toString('hex');
                account = this.web3.eth.accounts.privateKeyToAccount('0x' + privateKey);
                this.db.secureSet('account', { privateKey: account.privateKey });

                const table = new Table({
                    head: [{ colSpan: 2, content: 'New Account Created' }],
                    style: { head: ['green'] },
                    wordWrap: true
                });

                table.push(
                    ['Address', account.address],
                    ['Private Key', account.privateKey],
                    ['Mnemonic Phrase', mnemonic],
                    ['WARNING', "Please write down your mnemonic phrase and keep it in a safe place. \nIt\'s crucial for recovering your account."]
                );

                console.log('\n' + table.toString());
            }
        } else {
            account = this.web3.eth.accounts.privateKeyToAccount(account.privateKey);
        }

        this.account = account;
    }

    async importFrom12Words() {
        const { mnemonic } = await inquirer.prompt({
            type: 'password',
            name: 'mnemonic',
            message: 'Enter your 12-word mnemonic phrase:',
            mask: '*',
        });

        if (!bip39.validateMnemonic(mnemonic)) {
            console.error('Invalid mnemonic phrase');
            return null;
        }

        const seed = await bip39.mnemonicToSeed(mnemonic);
        const root = hdkey.fromMasterSeed(seed);
        const addrNode = root.derive("m/44'/60'/0'/0/0");
        const privateKey = addrNode.privateKey.toString('hex');
        const account = this.web3.eth.accounts.privateKeyToAccount('0x' + privateKey);

        await this.db.secureSet('account', { privateKey: account.privateKey });

        return account;
    }

    async showBalance() {
        if (!this.account) {
            console.error('Account not initialized. Please try restarting the application.');
            return;
        }

        const balanceWei = await this.web3.eth.getBalance(this.account.address);
        const balance = Web3.utils.fromWei(balanceWei, 'ether');

        const table = new Table({
            head: ['Token', 'Balance'],
            style: { head: ['blue'] },
            colWidths: [21, 22]
        });

        // Add address as the top row
        // table.push([{ colSpan: 2, content: this.account.address }]);
        table.push([this.selectedNetwork.nativeToken, parseFloat(balance).toFixed(8)]);

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

            table.push(['USDT', formattedUsdtBalance.toFixed(8)]);
        }

        console.log(table.toString());
        console.log('');
    }

    async transferFunds() {
        let addressBook = this.db.get('addressBook') || [];

        const { token } = await inquirer.prompt({
            type: 'list',
            name: 'token',
            message: 'Token to transfer:',
            choices: Object.keys(this.selectedNetwork.tokens),
        });

        const tokens = this.selectedNetwork.tokens;

        // Implement autocomplete for address book
        const { recipient } = await inquirer.prompt({
            type: 'autocomplete',
            name: 'recipient',
            message: 'Recipient address:',
            source: (answersSoFar, input) => {
                input = input || '';
                return addressBook
                    .filter(entry => entry.name.toLowerCase().includes(input.toLowerCase()) || entry.address.toLowerCase().includes(input.toLowerCase()))
                    .map(entry => ({ name: `${entry.name} (${entry.address})`, value: entry.address }))
                    .concat([{ name: input, value: input }]); // Add the input as a possible choice
            },
        });

        let address = recipient;

        const { amount } = await inquirer.prompt({
            type: 'input',
            name: 'amount',
            message: `Amount to transfer [${token}] (leave empty to cancel):`,
            validate: value => {
                if (value === '') return true;
                return !isNaN(value) && Number(value) > 0 ? true : 'Please enter a valid number or leave empty to cancel.';
            },
        });

        if (amount === '') {
            console.log('Transaction cancelled.');
            return;
        }

        try {
            let signedTx;
            if (tokens[token] && token !== this.selectedNetwork.nativeToken) {
                signedTx = await this.handleERC20Transfer(token, address, amount);
            } else {
                signedTx = await this.handleNativeTransfer(address, amount);
            }

            const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            await this.displayTransactionResult(receipt);

            // Add transaction to history
            this.addToTransactions(address, token, amount, receipt);

            if (!addressBook.some(entry => entry.address === address)) {
                await this.addToAddressBook(address);
            }

        } catch (error) {
            await this.displayTransactionResult(null, error);
        }
    }

    addToTransactions(recipient, token, amount, receipt) {
        const transaction = {
            timestamp: new Date().toISOString(),
            recipient,
            token,
            amount,
            hash: receipt.transactionHash
        };
        this.db.add('transactions', this.selectedNetwork.nativeToken, transaction);
    }

    async showTransactions() {
        const history = this.db.values('transactions', this.selectedNetwork.nativeToken) || [];

        const table = new Table({
            head: ['Date', 'Recipient', 'Token', 'Amount'],
            style: { head: ['blue'] },
        });

        if (history.length === 0) {
            table.push([{ colSpan: 4, content: 'No transaction history available.' }]);
        }

        history.forEach(tx => {
            const date = new Date(tx.timestamp).toLocaleString('en-GB', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }).replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1').replace(",", "");
            table.push([date, tx.recipient, tx.token, tx.amount]);
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
            let addressBook = this.db.get('addressBook') || [];
            addressBook.push({ name, address });
            this.db.set('addressBook', addressBook);

            const table = new Table({
                head: [{ colSpan: 2, content: "Recipient saved to the address book." }],
                style: { head: ['green'] },
            });

            table.push([name, address]);
            console.log('\n' + table.toString());
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
            if (error instanceof Web3ValidatorError) {
                const table = new Table({
                    head: [{ colSpan: 2, content: 'Error: Invalid Address' }],
                    style: { head: ['red'] }
                });
                table.push(['Address', recipient]);
                console.log(table.toString());
            }
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
                head: [{ colSpan: 2, content: 'Insufficient balance for this transaction' }],
                style: { head: ['red'] },
                wordWrap: true
            });
            table.push(['Maximum Amount', `${maxAmount} ${this.selectedNetwork.nativeToken}`]);
            console.log(table.toString());
            return;
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

    async displayTransactionResult(receipt, error = null) {
        if (receipt) {
            const gasUsed = receipt.gasUsed;
            const gasPrice = await this.web3.eth.getGasPrice();
            const transactionFee = this.web3.utils.fromWei((BigInt(gasUsed) * BigInt(gasPrice)).toString(), 'ether');

            const table = new Table({
                head: [{ colSpan: 2, content: 'Transaction successful, share this link with the recipient' }],
                style: { head: ['green'] }
            });
            table.push(
                ['Explorer', this.selectedNetwork.explorer + receipt.transactionHash],
                ['Fee', `${transactionFee} ${this.selectedNetwork.nativeToken}`],
            );

            console.log('\n' + table.toString());
        } else if (error) {
            const table = new Table({
                head: [error.message],
                style: { head: ['red'] },
                wordWrap: true,
            });

            if (error.reason) {
                table.push([error.reason.replace(/(\w+):/g, "\n$1:").trim()]);
            }

            console.log('\n' + table.toString());
        }
    }

    clearAccountData() {
        if (this.account) {
            this.account.privateKey = '0'.repeat(64);
            this.account = null;
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

async function main() {
    UIManager.displayWelcome();
    const encryptionKey = await UIManager.getEncryptionKey();
    const wallet = new Wallet(encryptionKey);

    // Check if an account exists
    const accountExists = wallet.db.secureGet('account');
    if (accountExists === null) {
        console.error('Wrong password.');
        process.exit(1);
    }

    if (!accountExists) {
        const confirmedKey = await UIManager.confirmEncryptionKey(encryptionKey);
        if (confirmedKey !== encryptionKey) {
            console.error('Passwords do not match. Please try again.');
            process.exit(1);
        }
    }

    try {
        await wallet.initialize();
        if (accountExists) wallet.displayAccountAddress();
    } catch (error) {
        console.error('Failed to initialize wallet:', error);
        process.exit(1);
    }

    // Register the displayExitPhrase method and account clearing to be called on process exit
    process.on('exit', () => {
        wallet.clearAccountData();
        UIManager.displayExitPhrase();
    });

    while (true) {
        const { action } = await inquirer.prompt({
            type: 'list',
            name: 'action',
            message: 'What would you like to do?',
            choices: ['Transfer funds', 'Show balance', 'Show transactions', 'Change account', 'Exit'],
        });

        if (action === 'Transfer funds') {
            await wallet.transferFunds();
        } else if (action === 'Show balance') {
            await wallet.showBalance();
        } else if (action === 'Show transactions') {
            await wallet.showTransactions();
        } else if (action === 'Change account') {
            await wallet.loadAccount(true);
        } else {
            process.exit();
        }
    }
}

main().catch(error => {
    console.error('An unexpected error occurred:', error);
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('\n');
    process.exit();
});