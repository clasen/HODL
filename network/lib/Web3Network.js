import BaseNetwork from './BaseNetwork.js';
import Web3 from 'web3';
import { ERC20_ABI } from '../abis/erc20.js';
import bip39 from 'bip39';
import hdkey from 'hdkey';

export default class Web3Network extends BaseNetwork {
    constructor(config) {
        super();
        this.web3 = new Web3(config.url);
        this.config = config;
    }

    async getBalance(address) {
        const balanceWei = await this.web3.eth.getBalance(address);
        return this.web3.utils.fromWei(balanceWei, 'ether');
    }

    async transfer(from, to, amount, options = {}) {
        const gasPrice = await this.getGasPrice();
        const gasLimit = options.gasLimit || 21000;
        
        const tx = {
            from: from.address,
            to,
            value: this.web3.utils.toWei(amount.toString(), 'ether'),
            gas: gasLimit,
            gasPrice
        };

        return this.web3.eth.accounts.signTransaction(tx, from.privateKey);
    }

    async transferToken(from, to, amount, tokenSymbol, options = {}) {
        const tokenConfig = this.config.tokens[tokenSymbol];
        if (!tokenConfig) throw new Error(`Token ${tokenSymbol} not supported`);

        const contract = new this.web3.eth.Contract(ERC20_ABI, tokenConfig.address);
        const decimals = await contract.methods.decimals().call();
        const value = BigInt(amount * (10 ** decimals));

        const data = contract.methods.transfer(to, value.toString()).encodeABI();
        const gasLimit = options.gasLimit || 100000;
        const gasPrice = await this.getGasPrice();

        const tx = {
            from: from.address,
            to: tokenConfig.address,
            data,
            gas: gasLimit,
            gasPrice
        };

        return this.web3.eth.accounts.signTransaction(tx, from.privateKey);
    }

    async estimateGas(transaction) {
        return this.web3.eth.estimateGas(transaction);
    }

    async getGasPrice() {
        return this.web3.eth.getGasPrice();
    }

    async handleERC20Transfer(account, token, recipient, amount) {
        const tokenConfig = this.config.tokens[token];
        if (!tokenConfig) throw new Error(`Token ${token} not supported`);

        const contract = new this.web3.eth.Contract(ERC20_ABI, tokenConfig.address);
        const decimals = parseInt(await contract.methods.decimals().call(), 10);

        const weiAmount = BigInt(this.web3.utils.toWei(amount, 'ether'));
        const adjustedAmount = weiAmount / (10n ** BigInt(18 - decimals));

        const data = contract.methods.transfer(recipient, adjustedAmount.toString()).encodeABI();
        const gasLimit = 100000;
        const gasPrice = await this.web3.eth.getGasPrice();

        const tx = {
            from: account.address,
            to: tokenConfig.address,
            data: data,
            gas: gasLimit,
            gasPrice: gasPrice,
        };

        return this.web3.eth.accounts.signTransaction(tx, account.privateKey);
    }

    async handleNativeTransfer(account, recipient, amount) {
        const gasPrice = await this.getGasPrice();
        const gasLimit = await this.estimateGas({
            from: account.address,
            to: recipient,
            value: amount
        });

        return this.transfer(account, recipient, amount, { gasLimit, gasPrice });
    }

    async getTokenBalances(address) {
        const balances = [];
        
        // Get native token balance
        const nativeBalance = await this.getBalance(address);
        balances.push([this.config.nativeToken, parseFloat(nativeBalance)]);

        // Get balances for all configured tokens
        for (const [symbol, tokenConfig] of Object.entries(this.config.tokens)) {
            const contract = new this.web3.eth.Contract(
                ERC20_ABI, 
                tokenConfig.address
            );
            const balance = await contract.methods.balanceOf(address).call();
            const decimals = await contract.methods.decimals().call();

            const formattedBalance = Number(
                (BigInt(balance) * 100n) / (10n ** BigInt(decimals))
            ) / 100;

            balances.push([symbol, formattedBalance]);
        }

        return balances;
    }

    async privateKeyToAccount(privateKey) {
        if (!privateKey) {
            throw new Error('Private key is required');
        }
        
        // Ensure private key has '0x' prefix
        const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
        
        try {
            return this.web3.eth.accounts.privateKeyToAccount(formattedKey);
        } catch (error) {
            throw new Error(`Invalid private key: ${error.message}`);
        }
    }

    async createAccount() {
        return this.web3.eth.accounts.create();
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
            throw new Error('Failed to create account from mnemonic: ' + error.message);
        }
    }

    validateMnemonic(mnemonic) {
        return bip39.validateMnemonic(mnemonic);
    }

    async sendSignedTransaction(signedTx) {
        return this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    }
} 