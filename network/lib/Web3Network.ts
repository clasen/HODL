import BaseNetwork from './BaseNetwork.js';
import { Web3 } from 'web3';
import { ERC20_ABI } from '../abis/erc20.js';
import bip39 from 'bip39';
import hdkey from 'hdkey';
import type {
    NetworkConfig,
    SignedTransaction,
    TransferOptions,
    WalletAccount
} from '../types.js';

export default class Web3Network extends BaseNetwork {
    private web3: Web3;

    constructor(config: NetworkConfig) {
        super(config);
        this.web3 = new Web3(config.url);
    }

    async getBalance(address: string): Promise<string> {
        const balanceWei = await this.web3.eth.getBalance(address);
        return this.web3.utils.fromWei(balanceWei, 'ether');
    }

    async transfer(
        from: WalletAccount,
        to: string,
        amount: number | string,
        options: TransferOptions = {}
    ): Promise<SignedTransaction> {
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

    async transferToken(
        from: WalletAccount,
        to: string,
        amount: number | string,
        tokenSymbol: string,
        options: TransferOptions = {}
    ): Promise<SignedTransaction> {
        const tokenConfig = this.config.tokens[tokenSymbol];
        if (!tokenConfig) throw new Error(`Token ${tokenSymbol} not supported`);

        const contract = new this.web3.eth.Contract(ERC20_ABI, tokenConfig.address);
        const decimals = Number(await contract.methods.decimals().call());
        const numericAmount = typeof amount === 'number' ? amount : Number(amount);
        const value = BigInt(numericAmount * (10 ** decimals));

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

    async estimateGas(transaction: Parameters<Web3['eth']['estimateGas']>[0]): Promise<bigint> {
        return this.web3.eth.estimateGas(transaction);
    }

    async getGasPrice(): Promise<bigint> {
        return this.web3.eth.getGasPrice();
    }

    async handleERC20Transfer(
        account: WalletAccount,
        token: string,
        recipient: string,
        amount: number | string
    ): Promise<SignedTransaction> {
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

    async handleNativeTransfer(
        account: WalletAccount,
        recipient: string,
        amount: number | string
    ): Promise<SignedTransaction> {
        const gasPrice = await this.getGasPrice();
        const valueInWei = this.web3.utils.toWei(amount.toString(), 'ether');
        const gasLimit = await this.estimateGas({
            from: account.address,
            to: recipient,
            value: valueInWei
        });

        return this.transfer(account, recipient, amount, { gasLimit, gasPrice });
    }

    async getTokenBalance(address: string, tokenSymbol: string): Promise<string | number> {
        if (tokenSymbol === this.config.nativeToken) {
            return await this.getBalance(address);
        }

        const tokenConfig = this.config.tokens[tokenSymbol];
        if (!tokenConfig) throw new Error(`Token ${tokenSymbol} not supported`);

        const contract = new this.web3.eth.Contract(ERC20_ABI, tokenConfig.address);
        const balance = String(await contract.methods.balanceOf(address).call());
        const decimals = Number(await contract.methods.decimals().call());

        return Number(
            (BigInt(balance) * 100n) / (10n ** BigInt(decimals))
        ) / 100;
    }

    async privateKeyToAccount(privateKey: string): Promise<WalletAccount> {
        if (!privateKey) {
            throw new Error('Private key is required');
        }
        
        // Ensure private key has '0x' prefix
        const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
        
        try {
            return this.web3.eth.accounts.privateKeyToAccount(formattedKey);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid private key: ${message}`);
        }
    }

    async createAccount(): Promise<WalletAccount> {
        return this.web3.eth.accounts.create();
    }

    async accountFromMnemonic(mnemonic: string): Promise<WalletAccount> {
        const seed = await bip39.mnemonicToSeed(mnemonic);
        const root = hdkey.fromMasterSeed(seed);
        const addrNode = root.derive("m/44'/60'/0'/0/0");
        const privateKey = addrNode.privateKey.toString('hex');
        const account = this.web3.eth.accounts.privateKeyToAccount('0x' + privateKey);
        return { ...account, mnemonic };
    }

    async createAccountFromMnemonic(wordCount: 12 | 24 = 12): Promise<WalletAccount> {
        try {
            const strength = wordCount === 24 ? 256 : 128;
            const mnemonic = bip39.generateMnemonic(strength);
            return this.accountFromMnemonic(mnemonic);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error('Failed to create account from mnemonic: ' + message);
        }
    }

    validateMnemonic(mnemonic: string): boolean {
        return bip39.validateMnemonic(mnemonic);
    }

    async sendSignedTransaction(signedTx: SignedTransaction | string): Promise<unknown> {
        if (typeof signedTx === 'string') {
            return this.web3.eth.sendSignedTransaction(signedTx);
        }

        if (!signedTx.rawTransaction) {
            throw new Error('Signed transaction rawTransaction is required.');
        }

        return this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    }
}
