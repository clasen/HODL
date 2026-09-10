import BaseNetwork from './BaseNetwork.js';
import { Web3 } from 'web3';
import { ERC20_ABI } from '../abis/erc20.js';
import bip39 from 'bip39';
import hdkey from 'hdkey';
import { formatUnits, parseDecimalToUnits } from '../../amounts.js';
import type {
    AssetBalance,
    NetworkConfig,
    PreparedTransfer,
    SignedTransaction,
    TransactionStatus,
    TransferOptions,
    WalletAccount
} from '../types.js';

export default class Web3Network extends BaseNetwork {
    private web3: Web3;

    constructor(config: NetworkConfig) {
        super(config);
        this.web3 = new Web3(config.url);
    }

    private formatPrivateKey(privateKey: string): string {
        return privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    }

    validateAddress(address: string): boolean {
        return this.web3.utils.isAddress(address);
    }

    async getBalance(address: string): Promise<string> {
        const balanceWei = await this.web3.eth.getBalance(address);
        return formatUnits(balanceWei, 18);
    }

    async transfer(
        from: WalletAccount,
        to: string,
        amount: number | string,
        options: TransferOptions = {}
    ): Promise<SignedTransaction> {
        const prepared = await this.prepareTransfer(
            from,
            to,
            amount.toString(),
            this.config.nativeToken,
            options
        );
        return {
            rawTransaction: prepared.rawTransaction,
            transactionHash: prepared.transactionHash
        };
    }

    async transferToken(
        from: WalletAccount,
        to: string,
        amount: number | string,
        tokenSymbol: string,
        options: TransferOptions = {}
    ): Promise<SignedTransaction> {
        const prepared = await this.prepareTransfer(
            from,
            to,
            amount.toString(),
            tokenSymbol,
            options
        );
        return {
            rawTransaction: prepared.rawTransaction,
            transactionHash: prepared.transactionHash
        };
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
        return this.transferToken(account, recipient, amount, token);
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

    async getTokenBalance(address: string, tokenSymbol: string): Promise<string> {
        return (await this.getAssetBalance(address, tokenSymbol)).amount;
    }

    async getAssetBalance(address: string, asset: string): Promise<AssetBalance> {
        if (!this.validateAddress(address)) {
            throw new Error('Invalid EVM address.');
        }

        const symbol = asset.toUpperCase();
        if (symbol === this.config.nativeToken) {
            const baseUnits = await this.web3.eth.getBalance(address);
            return {
                asset: symbol,
                amount: formatUnits(baseUnits, 18),
                baseUnits: baseUnits.toString(),
                decimals: 18
            };
        }

        const tokenConfig = this.config.tokens[symbol];
        if (!tokenConfig) {
            throw new Error(`Token ${symbol} not supported`);
        }

        const contract = new this.web3.eth.Contract(ERC20_ABI, tokenConfig.address);
        const baseUnits = String(await contract.methods.balanceOf(address).call());
        const decimals = Number(await contract.methods.decimals().call());
        if (!Number.isInteger(decimals) || decimals < 0) {
            throw new Error(`Token ${symbol} returned invalid decimals.`);
        }

        return {
            asset: symbol,
            amount: formatUnits(baseUnits, decimals),
            baseUnits,
            decimals
        };
    }

    async prepareTransfer(
        from: WalletAccount,
        to: string,
        amount: string,
        asset: string,
        options: TransferOptions = {}
    ): Promise<PreparedTransfer> {
        if (!this.validateAddress(from.address) || !this.validateAddress(to)) {
            throw new Error('Invalid EVM address.');
        }

        const configuredChainId = this.config.chainId;
        if (configuredChainId === undefined) {
            throw new Error(`Network ${this.config.id} does not define a chain ID.`);
        }

        const providerChainId = Number(await this.web3.eth.getChainId());
        if (providerChainId !== configuredChainId) {
            throw new Error(
                `RPC chain ID mismatch: expected ${configuredChainId}, received ${providerChainId}.`
            );
        }

        const symbol = asset.toUpperCase();
        const balance = await this.getAssetBalance(from.address, symbol);
        const maximum = amount.trim().toLowerCase() === 'max';
        let amountBaseUnits = maximum ? BigInt(balance.baseUnits) : parseDecimalToUnits(amount, balance.decimals);
        if (amountBaseUnits <= 0n) throw new Error(`Insufficient ${symbol} balance.`);
        if (BigInt(balance.baseUnits) < amountBaseUnits) {
            throw new Error(`Insufficient ${symbol} balance.`);
        }

        const gasPrice = options.gasPrice !== undefined
            ? BigInt(options.gasPrice)
            : await this.getGasPrice();
        const nonce = await this.web3.eth.getTransactionCount(from.address, 'pending');
        let transaction: Record<string, unknown>;

        if (symbol === this.config.nativeToken) {
            transaction = {
                from: from.address,
                to,
                value: maximum ? '0' : amountBaseUnits.toString()
            };
        } else {
            const tokenConfig = this.config.tokens[symbol];
            if (!tokenConfig) {
                throw new Error(`Token ${symbol} not supported`);
            }
            const contract = new this.web3.eth.Contract(ERC20_ABI, tokenConfig.address);
            transaction = {
                from: from.address,
                to: tokenConfig.address,
                data: contract.methods.transfer(to, amountBaseUnits.toString()).encodeABI(),
                value: '0'
            };
        }

        const gas = options.gasLimit !== undefined
            ? BigInt(options.gasLimit)
            : await this.web3.eth.estimateGas(transaction);
        const feeBaseUnits = gas * gasPrice;
        const nativeBalance = await this.getAssetBalance(from.address, this.config.nativeToken);
        if (maximum && symbol === this.config.nativeToken) {
            amountBaseUnits = BigInt(nativeBalance.baseUnits) - feeBaseUnits;
            if (amountBaseUnits <= 0n) throw new Error(`Insufficient ${symbol} balance for fee.`);
            transaction.value = amountBaseUnits.toString();
            if (options.gasLimit === undefined && await this.web3.eth.estimateGas(transaction) > gas) {
                throw new Error('Gas estimate increased for the maximum amount. Specify a smaller amount.');
            }
        }
        const requiredNative = symbol === this.config.nativeToken
            ? amountBaseUnits + feeBaseUnits
            : feeBaseUnits;
        if (BigInt(nativeBalance.baseUnits) < requiredNative) {
            throw new Error(`Insufficient ${this.config.nativeToken} balance for amount and fee.`);
        }

        const signed = await this.web3.eth.accounts.signTransaction({
            ...transaction,
            nonce,
            gas,
            gasPrice,
            chainId: configuredChainId
        }, from.privateKey);
        if (!signed.rawTransaction) {
            throw new Error('Failed to create a signed transaction.');
        }

        const transactionHash = signed.transactionHash || this.web3.utils.keccak256(signed.rawTransaction);
        if (!transactionHash) {
            throw new Error('Failed to calculate transaction hash.');
        }

        return {
            from: from.address,
            to,
            asset: symbol,
            amount: formatUnits(amountBaseUnits, balance.decimals),
            amountBaseUnits: amountBaseUnits.toString(),
            fee: {
                asset: this.config.nativeToken,
                amount: formatUnits(feeBaseUnits, 18),
                baseUnits: feeBaseUnits.toString(),
                decimals: 18,
                estimated: true
            },
            transactionHash,
            rawTransaction: signed.rawTransaction
        };
    }

    async getTransactionStatus(transactionHash: string): Promise<TransactionStatus> {
        const receipt = await this.web3.eth.getTransactionReceipt(transactionHash);
        if (receipt) {
            return {
                state: isFailedReceiptStatus(receipt.status) ? 'failed' : 'confirmed',
                transactionHash
            };
        }

        const transaction = await this.web3.eth.getTransaction(transactionHash);
        return {
            state: transaction ? 'submitted' : 'not_found',
            transactionHash
        };
    }

    validatePrivateKey(privateKey: string): boolean {
        if (!privateKey) {
            return false;
        }

        try {
            this.web3.eth.accounts.privateKeyToAccount(this.formatPrivateKey(privateKey));
            return true;
        } catch {
            return false;
        }
    }

    async privateKeyToAccount(privateKey: string): Promise<WalletAccount> {
        if (!privateKey) {
            throw new Error('Private key is required');
        }
        
        try {
            return this.web3.eth.accounts.privateKeyToAccount(this.formatPrivateKey(privateKey));
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
        let receipt: Awaited<ReturnType<Web3['eth']['sendSignedTransaction']>>;
        if (typeof signedTx === 'string') {
            receipt = await this.web3.eth.sendSignedTransaction(signedTx);
        } else {
            if (!signedTx.rawTransaction) {
                throw new Error('Signed transaction rawTransaction is required.');
            }
            receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
        }

        if (isFailedReceiptStatus(receipt.status)) {
            throw new Error('Transaction was mined but reverted.');
        }
        return receipt;
    }
}

function isFailedReceiptStatus(status: unknown): boolean {
    return status === false || status === 0 || status === 0n || status === '0x0';
}
