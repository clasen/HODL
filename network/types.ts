export type TokenConfig = {
    address: string;
    decimals?: number;
};

export type NetworkConfig = {
    id: string;
    family: 'evm' | 'bitcoin';
    name: string;
    url: string;
    nativeToken: string;
    explorer: string;
    tokens: Record<string, TokenConfig>;
    chainId?: number;
    network?: string;
    feeRate?: number;
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

export type AssetBalance = {
    asset: string;
    amount: string;
    baseUnits: string;
    decimals: number;
};

export type FeeEstimate = AssetBalance & {
    estimated: true;
};

export type PreparedTransfer = {
    from: string;
    to: string;
    asset: string;
    amount: string;
    amountBaseUnits: string;
    fee: FeeEstimate;
    transactionHash: string;
    rawTransaction: string;
};

export type TransactionStatus = {
    state: 'not_found' | 'submitted' | 'confirmed' | 'failed';
    transactionHash: string;
};

export type NetworkUsageEntry = {
    count: number;
    lastUsed: number;
};

export type NetworkUsage = Record<string, NetworkUsageEntry | number>;

export interface BaseNetworkContract {
    config: NetworkConfig;
    name: string;

    getBalance(address: string): Promise<string>;
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
    validatePrivateKey(privateKey: string): boolean;
    privateKeyToAccount(privateKey: string): Promise<WalletAccount>;
    createAccount(): Promise<WalletAccount>;
    accountFromMnemonic(mnemonic: string): Promise<WalletAccount>;
    createAccountFromMnemonic(wordCount?: 12 | 24): Promise<WalletAccount>;
    validateMnemonic(mnemonic: string): boolean;
    getTokenBalance(address: string, tokenSymbol: string): Promise<string>;
    getTokenBalances(address: string): Promise<Array<[string, string]>>;
    getAssetBalance(address: string, asset: string): Promise<AssetBalance>;
    validateAddress(address: string): boolean;
    prepareTransfer(
        from: WalletAccount,
        to: string,
        amount: string,
        asset: string,
        options?: TransferOptions
    ): Promise<PreparedTransfer>;
    getTransactionStatus(transactionHash: string): Promise<TransactionStatus>;
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
