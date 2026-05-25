export type TokenConfig = {
    address: string;
    decimals?: number;
};

export type NetworkConfig = {
    name: string;
    url: string;
    nativeToken: string;
    explorer: string;
    tokens: Record<string, TokenConfig>;
    network?: string;
};

export type NetworkConstructor = new (config: NetworkConfig) => BaseNetworkContract;

export type NetworkPlugin = NetworkConfig & {
    NetworkClass: NetworkConstructor;
    fileName?: string;
};

export type WalletAccount = {
    address: string;
    privateKey: string;
    publicKey?: string;
    mnemonic?: string;
};

export type TransferOptions = {
    gasLimit?: number | bigint;
    gasPrice?: string | bigint;
    feeRate?: number;
};

export type SignedTransaction = {
    rawTransaction?: string;
    transactionHash?: string;
};

export type NetworkUsageEntry = {
    count: number;
    lastUsed: number;
};

export type NetworkUsage = Record<string, NetworkUsageEntry | number>;

export interface BaseNetworkContract {
    config: NetworkConfig;
    name: string;

    getBalance(address: string): Promise<string | number>;
    transfer(
        from: WalletAccount,
        to: string,
        amount: number | string,
        options?: TransferOptions
    ): Promise<SignedTransaction | string | unknown>;
    transferToken(
        from: WalletAccount,
        to: string,
        amount: number | string,
        tokenSymbol: string,
        options?: TransferOptions
    ): Promise<SignedTransaction | string | unknown>;
    estimateGas(transaction: unknown): Promise<unknown>;
    getGasPrice(): Promise<unknown>;
    privateKeyToAccount(privateKey: string): Promise<WalletAccount>;
    createAccount(): Promise<WalletAccount>;
    accountFromMnemonic(mnemonic: string): Promise<WalletAccount>;
    createAccountFromMnemonic(wordCount?: 12 | 24): Promise<WalletAccount>;
    validateMnemonic(mnemonic: string): boolean;
    getTokenBalance(address: string, tokenSymbol: string): Promise<string | number>;
    getTokenBalances(address: string): Promise<Array<[string, string | number]>>;
    sendSignedTransaction(signedTx: SignedTransaction | string): Promise<unknown>;
    handleNativeTransfer?(
        from: WalletAccount,
        to: string,
        amount: number | string,
        options?: TransferOptions
    ): Promise<SignedTransaction | string | unknown>;
    handleERC20Transfer?(
        from: WalletAccount,
        tokenSymbol: string,
        to: string,
        amount: number | string
    ): Promise<SignedTransaction | string | unknown>;
}
