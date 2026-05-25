import type {
    BaseNetworkContract,
    NetworkConfig,
    SignedTransaction,
    TransferOptions,
    WalletAccount
} from '../types.js';

export default abstract class BaseNetwork implements BaseNetworkContract {
    config: NetworkConfig;
    name: string;

    constructor(config: NetworkConfig) {
        this.config = config;
        this.name = config.name;
    }

    abstract getBalance(address: string): Promise<string | number>;

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

    abstract privateKeyToAccount(privateKey: string): Promise<WalletAccount>;

    abstract createAccount(): Promise<WalletAccount>;

    abstract accountFromMnemonic(mnemonic: string): Promise<WalletAccount>;

    abstract createAccountFromMnemonic(wordCount?: 12 | 24): Promise<WalletAccount>;

    abstract validateMnemonic(mnemonic: string): boolean;

    abstract getTokenBalance(address: string, tokenSymbol: string): Promise<string | number>;

    async getTokenBalances(address: string): Promise<Array<[string, string | number]>> {
        const balances: Array<[string, string | number]> = [];

        const nativeBalance = await this.getBalance(address);
        balances.push([this.config.nativeToken, Number(nativeBalance)]);

        for (const symbol of Object.keys(this.config.tokens)) {
            const tokenBalance = await this.getTokenBalance(address, symbol);
            balances.push([symbol, tokenBalance]);
        }

        return balances;
    }

    abstract sendSignedTransaction(signedTx: SignedTransaction | string): Promise<unknown>;
}
