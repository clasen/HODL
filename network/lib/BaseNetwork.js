export default class BaseNetwork {
    constructor() {
        if (this.constructor === BaseNetwork) {
            throw new Error("Abstract classes can't be instantiated.");
        }
    }

    // Required methods that all networks must implement
    async getBalance(address) {
        throw new Error("Method 'getBalance' must be implemented.");
    }

    async transfer(from, to, amount, options = {}) {
        throw new Error("Method 'transfer' must be implemented.");
    }

    async getTokenBalance(address, tokenSymbol) {
        throw new Error("Method 'getTokenBalance' must be implemented.");
    }

    async transferToken(from, to, amount, tokenSymbol, options = {}) {
        throw new Error("Method 'transferToken' must be implemented.");
    }

    async estimateGas(transaction) {
        throw new Error("Method 'estimateGas' must be implemented.");
    }

    async getGasPrice() {
        throw new Error("Method 'getGasPrice' must be implemented.");
    }

    async privateKeyToAccount(privateKey) {
        throw new Error("Method 'privateKeyToAccount' must be implemented.");
    }

    async createAccount() {
        throw new Error("Method 'createAccount' must be implemented.");
    }

    // New required methods for mnemonic handling
    async accountFromMnemonic(mnemonic) {
        throw new Error("Method 'accountFromMnemonic' must be implemented.");
    }

    async createAccountFromMnemonic() {
        throw new Error("Method 'createAccountFromMnemonic' must be implemented.");
    }

    validateMnemonic(mnemonic) {
        throw new Error("Method 'validateMnemonic' must be implemented.");
    }

    // Add after line 51
    async sendSignedTransaction(signedTx) {
        throw new Error("Method 'sendSignedTransaction' must be implemented.");
    }
} 