import type {
    AssetBalance,
    BaseNetworkContract,
    NetworkConfig,
    PreparedTransfer,
    SignedTransaction,
    TransactionStatus,
    TransferOptions,
    TransferEstimate,
    WalletAccount
} from '../types.js';

export default abstract class BaseNetwork implements BaseNetworkContract {
    config: NetworkConfig;
    name: string;

    constructor(config: NetworkConfig) {
        this.config = config;
        this.name = config.name;
    }

    abstract getBalance(address: string): Promise<string>;

    abstract transfer(
        from: WalletAccount,
        to: string,
        amount: number | string,
        options?: TransferOptions
    ): Promise<SignedTransaction | string | unknown>;

    abstract transferToken(
        from: WalletAccount,
        to: string,
        amount: number | string,
        tokenSymbol: string,
        options?: TransferOptions
    ): Promise<SignedTransaction | string | unknown>;

    abstract estimateGas(transaction: unknown): Promise<unknown>;

    abstract getGasPrice(): Promise<unknown>;

    abstract validatePrivateKey(privateKey: string): boolean;

    abstract privateKeyToAccount(privateKey: string): Promise<WalletAccount>;

    abstract createAccount(): Promise<WalletAccount>;

    abstract accountFromMnemonic(mnemonic: string): Promise<WalletAccount>;

    abstract createAccountFromMnemonic(wordCount?: 12 | 24): Promise<WalletAccount>;

    abstract validateMnemonic(mnemonic: string): boolean;

    abstract getTokenBalance(address: string, tokenSymbol: string): Promise<string>;

    abstract getAssetBalance(address: string, asset: string): Promise<AssetBalance>;

    abstract validateAddress(address: string): boolean;

    protected checkFeeLimit(fee: bigint, maximum?: string): void {
        if (maximum === undefined) return;
        if (!/^(0|[1-9]\d*)$/.test(maximum)) throw new TypeError('Fee limit must be a non-negative integer in base units.');
        if (fee > BigInt(maximum)) throw new RangeError('Estimated fee exceeds the confirmed limit. Review the transfer again.');
    }

    abstract estimateTransfer(
        from: string,
        to: string,
        amount: string,
        asset: string,
        options?: TransferOptions
    ): Promise<TransferEstimate>;

    abstract prepareTransfer(
        from: WalletAccount,
        to: string,
        amount: string,
        asset: string,
        options?: TransferOptions
    ): Promise<PreparedTransfer>;

    abstract getTransactionStatus(transactionHash: string): Promise<TransactionStatus>;

    async getTokenBalances(address: string): Promise<Array<[string, string]>> {
        const balances: Array<[string, string]> = [];

        const nativeBalance = await this.getBalance(address);
        balances.push([this.config.nativeToken, nativeBalance]);

        for (const symbol of Object.keys(this.config.tokens)) {
            const tokenBalance = await this.getTokenBalance(address, symbol);
            balances.push([symbol, tokenBalance]);
        }

        return balances;
    }

    abstract sendSignedTransaction(signedTx: SignedTransaction | string): Promise<unknown>;
}
