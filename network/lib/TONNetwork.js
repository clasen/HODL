import BaseNetwork from './BaseNetwork.js';
import { TonClient } from '@ton/ton';
import { WalletContractV4 } from '@ton/ton';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';

export default class TONNetwork extends BaseNetwork {
    constructor(config) {
        super();
        this.initializeClient(config);
        this.config = config;
    }

    async initializeClient(config) {
        const endpoint = config.url;
        this.client = new TonClient({ endpoint });
    }

    async getBalance(address) {
        const contract = await this.client.open(WalletContractV4.create({ address }));
        const balance = await contract.getBalance();
        return balance / 1e9; // Convert from nanoTON to TON
    }

    async transfer(from, to, amount, options = {}) {
        const wallet = this.client.open(WalletContractV4.create({ 
            publicKey: from.publicKey,
            workchain: 0 
        }));

        const transfer = wallet.createTransfer({
            secretKey: from.secretKey,
            to,
            value: BigInt(amount * 1e9), // Convert TON to nanoTON
            bounce: false,
            seqno: await wallet.getSeqno(),
        });

        return wallet.send(transfer);
    }

    async getTokenBalance(address, tokenSymbol) {
        const tokenConfig = this.config.tokens[tokenSymbol];
        if (!tokenConfig) throw new Error(`Token ${tokenSymbol} not supported`);

        // TON token implementation would go here
        // Note: TON's token system is different from ERC20
        throw new Error('Token operations not yet implemented for TON');
    }

    async createAccount() {
        const mnemonic = await this.generateMnemonic();
        return this.accountFromMnemonic(mnemonic);
    }

    async accountFromMnemonic(mnemonic) {
        const keyPair = await mnemonicToPrivateKey(mnemonic);
        const wallet = WalletContractV4.create({ 
            publicKey: keyPair.publicKey,
            workchain: 0 
        });

        return {
            address: wallet.address.toString(),
            publicKey: keyPair.publicKey,
            secretKey: keyPair.secretKey,
            mnemonic
        };
    }

    async createAccountFromMnemonic() {
        const mnemonic = await this.generateMnemonic();
        return this.accountFromMnemonic(mnemonic);
    }

    async generateMnemonic() {
        return await mnemonicNew();
    }

    validateMnemonic(mnemonic) {
        try {
            return validateMnemonic(mnemonic);
        } catch {
            return false;
        }
    }

    // TON-specific methods
    async getTransactions(address, limit = 20) {
        const transactions = await this.client.getTransactions(address, { limit });
        return transactions.map(tx => ({
            hash: tx.hash,
            value: tx.value / 1e9,
            from: tx.from,
            to: tx.to,
            timestamp: tx.timestamp
        }));
    }

    async getTokenBalances(address) {
        const balances = {};
        for (const tokenSymbol in this.config.tokens) {
            try {
                balances[tokenSymbol] = await this.getTokenBalance(address, tokenSymbol);
            } catch (error) {
                console.error(`Failed to get ${tokenSymbol} balance:`, error);
                balances[tokenSymbol] = 0; // Set to 0 if token balance check fails
            }
        }
        // Convert object to array of [token, balance] pairs
        return Object.entries(balances);
    }

    async sendSignedTransaction(signedTx) {
        return this.client.sendTransaction(signedTx);
    }
} 