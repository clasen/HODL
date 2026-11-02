export type TokenConfig = {
    address: string;
    decimals?: number;
};

/** Where an EVM network's token transfers are read from: `eth_getLogs` in ranges of `blockRange`, back to `lookbackBlocks` from the head. */
export type TransferHistoryConfig = {
    /** When the network's own endpoint cannot serve the logs. */
    url?: string;
    blockRange: number;
    lookbackBlocks: number;
};

export type NetworkConfig = {
    id: string;
    family: 'evm' | 'bitcoin';
    name: string;
    storageName?: string;
    url: string;
    nativeToken: string;
    explorer: string;
    tokens: Record<string, TokenConfig>;
    chainId?: number;
    network?: string;
    feeRate?: number;
    history?: TransferHistoryConfig;
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
    maxFeeBaseUnits?: string;
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

export type TransferEstimate = {
    from: string;
    to: string;
    asset: string;
    amount: string;
    amountBaseUnits: string;
    fee: FeeEstimate;
};

export type PreparedTransfer = TransferEstimate & {
    transactionHash: string;
    rawTransaction: string;
};

export type TransactionStatus = {
    state: 'not_found' | 'submitted' | 'confirmed' | 'failed';
    transactionHash: string;
};

/** A transfer into or out of an address, as the chain records it. */
export type ChainTransfer = {
    /** Unique per transfer: one transaction can hold several. */
    id: string;
    hash: string;
    direction: 'in' | 'out';
    /** The sender of an incoming transfer, the recipient of an outgoing one. */
    counterparty: string;
    asset: string;
    amount: string;
    /** Absent while unconfirmed. */
    timestamp?: string;
    state: 'pending' | 'confirmed';
};

/** One read of an address's transfers; `cursor` lets the next read start after them. */
export type TransferScan = {
    transfers: ChainTransfer[];
    cursor?: string;
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
    estimateTransfer(
        from: string,
        to: string,
        amount: string,
        asset: string,
        options?: TransferOptions
    ): Promise<TransferEstimate>;
    prepareTransfer(
        from: WalletAccount,
        to: string,
        amount: string,
        asset: string,
        options?: TransferOptions
    ): Promise<PreparedTransfer>;
    getTransactionStatus(transactionHash: string): Promise<TransactionStatus>;
    /**
     * Optional. The address's transfers in and out, newest first: without a cursor the latest ones, stopping once
     * `limit` are found; with the cursor of an earlier scan, all of those since that scan.
     */
    recentTransfers?(address: string, limit: number, cursor?: string): Promise<TransferScan>;
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
