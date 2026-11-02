import BaseNetwork from './BaseNetwork.js';
import {
    createPublicClient,
    encodeFunctionData,
    getAddress,
    http,
    keccak256,
    parseAbiItem,
    parseEther,
    toHex,
    TransactionNotFoundError,
    TransactionReceiptNotFoundError,
    type Address,
    type EstimateGasParameters,
    type Hex,
    type PublicClient,
    type TransactionSerializableLegacy
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ERC20_ABI } from '../abis/erc20.js';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { formatUnits, parseDecimalToUnits } from '../../amounts.js';
import { walletConfig } from '../../config.js';
import type {
    AssetBalance,
    ChainTransfer,
    NetworkConfig,
    PreparedTransfer,
    SignedTransaction,
    TransactionStatus,
    TransferHistoryConfig,
    TransferOptions,
    TransferScan,
    TransferEstimate,
    WalletAccount
} from '../types.js';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export default class Web3Network extends BaseNetwork {
    private client: PublicClient;

    constructor(config: NetworkConfig) {
        super(config);
        // A retried eth_sendRawTransaction would broadcast the transfer again.
        this.client = createPublicClient({ transport: http(config.url, { retryCount: 0 }) });
    }

    private formatPrivateKey(privateKey: string): Hex {
        return privateKey.startsWith('0x') ? privateKey as Hex : `0x${privateKey}`;
    }

    /** Accepts an optional 0x prefix and either a single case or a valid EIP-55 checksum. */
    validateAddress(address: string): boolean {
        if (!/^(0x)?[\da-f]{40}$/i.test(address)) return false;
        const digits = address.slice(-40);
        return digits === digits.toLowerCase() || digits === digits.toUpperCase()
            || getAddress(`0x${digits.toLowerCase()}`) === `0x${digits}`;
    }

    private address(address: string): Address {
        if (!this.validateAddress(address)) {
            throw new Error('Invalid EVM address.');
        }
        return getAddress(`0x${address.slice(-40).toLowerCase()}`);
    }

    async getBalance(address: string): Promise<string> {
        const balanceWei = await this.client.getBalance({ address: this.address(address) });
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

    async estimateGas(transaction: EstimateGasParameters): Promise<bigint> {
        return this.client.estimateGas(transaction);
    }

    async getGasPrice(): Promise<bigint> {
        return this.client.getGasPrice();
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
        const gasLimit = await this.estimateGas({
            account: this.address(account.address),
            to: this.address(recipient),
            value: parseEther(amount.toString())
        });

        return this.transfer(account, recipient, amount, { gasLimit, gasPrice });
    }

    async getTokenBalance(address: string, tokenSymbol: string): Promise<string> {
        return (await this.getAssetBalance(address, tokenSymbol)).amount;
    }

    /** Listed only where an endpoint serves the logs. Token transfers only: a standard RPC cannot look up native transfers by address. */
    get recentTransfers(): ((address: string, limit: number, cursor?: string) => Promise<TransferScan>) | undefined {
        const { history } = this.config;
        return history ? (address, limit, cursor) => this.recentTokenTransfers(history, address, limit, cursor) : undefined;
    }

    /** The cursor is the last block a later scan need not read again. */
    private async recentTokenTransfers(history: TransferHistoryConfig, address: string, limit: number, cursor?: string): Promise<TransferScan> {
        if (cursor !== undefined && !/^\d+$/.test(cursor)) throw new Error('Invalid transfer cursor.');
        const owner = this.address(address);
        const client = history.url ? createPublicClient({ transport: http(history.url) }) : this.client;
        const tokens = new Map(Object.entries(this.config.tokens).map(([symbol, token]) => [this.address(token.address), symbol]));
        if (tokens.size === 0) return { transfers: [] };

        const head = await client.getBlockNumber();
        const range = BigInt(history.blockRange);
        const reach = (blocks: number) => head >= BigInt(blocks) ? head - BigInt(blocks) + 1n : 0n;
        // A cursor within catch-up reach means everything after it is wanted; otherwise the latest `limit` are.
        const since = cursor !== undefined && BigInt(cursor) + 1n >= reach(history.catchUpBlocks) ? BigInt(cursor) + 1n : undefined;
        const oldest = reach(history.lookbackBlocks);
        const logs = (args: { from: Address } | { to: Address }, fromBlock: bigint, toBlock: bigint | 'latest') =>
            client.getLogs({ address: [...tokens.keys()], event: TRANSFER_EVENT, args, fromBlock, toBlock, strict: true });
        const found = new Map<string, Awaited<ReturnType<typeof logs>>[number]>();
        const read = async (fromBlock: bigint, toBlock: bigint | 'latest') => {
            const chunk = await Promise.all([logs({ to: owner }, fromBlock, toBlock), logs({ from: owner }, fromBlock, toBlock)]);
            for (const log of chunk.flat()) found.set(`${log.transactionHash}:${log.logIndex}`, log);
        };
        // Nodes behind one endpoint disagree on the head: the newest chunk ends at each node's own head
        // and spans half a range, so a node up to half a range ahead of this one stays within it. Being read
        // on every scan, it is where the next one picks up.
        const newest = head - range / 2n + 1n > 0n ? head - range / 2n + 1n : 0n;
        await read(newest, 'latest');
        const below = (toBlock: bigint, floor: bigint) => [toBlock - range + 1n > floor ? toBlock - range + 1n : floor, toBlock] as const;
        if (since !== undefined) {
            // Catching up needs every range down to the cursor, so several are read at once.
            const ranges: Array<readonly [bigint, bigint]> = [];
            for (let toBlock = newest - 1n; toBlock >= since; toBlock -= range) ranges.push(below(toBlock, since));
            for (let index = 0; index < ranges.length; index += walletConfig.history.parallelRanges) {
                await Promise.all(ranges.slice(index, index + walletConfig.history.parallelRanges).map(([fromBlock, toBlock]) => read(fromBlock, toBlock)));
            }
        } else {
            for (let toBlock = newest - 1n; toBlock >= oldest && found.size < limit; toBlock -= range) await read(...below(toBlock, oldest));
        }

        const latest = [...found.values()].sort((a, b) => Number(b.blockNumber - a.blockNumber) || b.logIndex - a.logIndex);
        const decimals = new Map(await Promise.all([...new Set(latest.map(log => getAddress(log.address)))].map(async token =>
            [token, Number(await client.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }))] as const)));
        // Some endpoints omit blockTimestamp from logs or report it as zero.
        const blocks = new Map(await Promise.all([...new Set(latest.filter(log => !log.blockTimestamp).map(log => log.blockNumber))]
            .map(async blockNumber => [blockNumber, (await client.getBlock({ blockNumber })).timestamp] as const)));
        const transfers = latest.map((log): ChainTransfer => {
            const token = getAddress(log.address);
            const outgoing = getAddress(log.args.from) === owner;
            const timestamp = log.blockTimestamp || blocks.get(log.blockNumber)!;
            return {
                id: `${log.transactionHash}:${log.logIndex}`,
                hash: log.transactionHash,
                direction: outgoing ? 'out' : 'in',
                counterparty: getAddress(outgoing ? log.args.to : log.args.from),
                asset: tokens.get(token)!,
                amount: formatUnits(log.args.value, decimals.get(token)!),
                timestamp: new Date(Number(timestamp) * 1000).toISOString(),
                state: 'confirmed'
            };
        });
        return { transfers, ...(newest > 0n ? { cursor: String(newest - 1n) } : {}) };
    }

    async getAssetBalance(address: string, asset: string): Promise<AssetBalance> {
        const owner = this.address(address);
        const symbol = asset.toUpperCase();
        if (symbol === this.config.nativeToken) {
            const baseUnits = await this.client.getBalance({ address: owner });
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

        const token = this.address(tokenConfig.address);
        const baseUnits = String(await this.client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }));
        const decimals = Number(await this.client.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }));
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

    private async buildTransfer(
        from: string,
        to: string,
        amount: string,
        asset: string,
        options: TransferOptions = {}
    ): Promise<{ estimate: TransferEstimate; transaction: TransactionSerializableLegacy }> {
        const sender = this.address(from);
        const recipient = this.address(to);

        const configuredChainId = this.config.chainId;
        if (configuredChainId === undefined) {
            throw new Error(`Network ${this.config.id} does not define a chain ID.`);
        }

        const providerChainId = await this.client.getChainId();
        if (providerChainId !== configuredChainId) {
            throw new Error(
                `RPC chain ID mismatch: expected ${configuredChainId}, received ${providerChainId}.`
            );
        }

        const symbol = asset.toUpperCase();
        const balance = await this.getAssetBalance(from, symbol);
        const maximum = amount.trim().toLowerCase() === 'max';
        let amountBaseUnits = maximum ? BigInt(balance.baseUnits) : parseDecimalToUnits(amount, balance.decimals);
        if (amountBaseUnits <= 0n) throw new Error(`Insufficient ${symbol} balance.`);
        if (BigInt(balance.baseUnits) < amountBaseUnits) {
            throw new Error(`Insufficient ${symbol} balance.`);
        }

        const gasPrice = options.gasPrice !== undefined
            ? BigInt(options.gasPrice)
            : await this.getGasPrice();
        const nonce = await this.client.getTransactionCount({ address: sender, blockTag: 'pending' });
        let transaction: { to: Address; value: bigint; data?: Hex };

        if (symbol === this.config.nativeToken) {
            transaction = {
                to: recipient,
                value: maximum ? 0n : amountBaseUnits
            };
        } else {
            const tokenConfig = this.config.tokens[symbol];
            if (!tokenConfig) {
                throw new Error(`Token ${symbol} not supported`);
            }
            transaction = {
                to: this.address(tokenConfig.address),
                data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [recipient, amountBaseUnits] }),
                value: 0n
            };
        }

        const gas = options.gasLimit !== undefined
            ? BigInt(options.gasLimit)
            : await this.client.estimateGas({ account: sender, ...transaction });
        const feeBaseUnits = gas * gasPrice;
        const nativeBalance = await this.getAssetBalance(from, this.config.nativeToken);
        if (maximum && symbol === this.config.nativeToken) {
            amountBaseUnits = BigInt(nativeBalance.baseUnits) - feeBaseUnits;
            if (amountBaseUnits <= 0n) throw new Error(`Insufficient ${symbol} balance for fee.`);
            transaction.value = amountBaseUnits;
            if (options.gasLimit === undefined && await this.client.estimateGas({ account: sender, ...transaction }) > gas) {
                throw new Error('Gas estimate increased for the maximum amount. Specify a smaller amount.');
            }
        }
        const requiredNative = symbol === this.config.nativeToken
            ? amountBaseUnits + feeBaseUnits
            : feeBaseUnits;
        if (BigInt(nativeBalance.baseUnits) < requiredNative) {
            throw new Error(`Insufficient ${this.config.nativeToken} balance for amount and fee.`);
        }

        return {
            transaction: { ...transaction, nonce, gas, gasPrice, chainId: configuredChainId, type: 'legacy' },
            estimate: {
                from, to, asset: symbol,
                amount: formatUnits(amountBaseUnits, balance.decimals),
                amountBaseUnits: amountBaseUnits.toString(),
                fee: { asset: this.config.nativeToken, amount: formatUnits(feeBaseUnits, 18),
                    baseUnits: feeBaseUnits.toString(), decimals: 18, estimated: true }
            }
        };
    }

    async estimateTransfer(from: string, to: string, amount: string, asset: string, options: TransferOptions = {}): Promise<TransferEstimate> {
        return (await this.buildTransfer(from, to, amount, asset, options)).estimate;
    }

    async prepareTransfer(from: WalletAccount, to: string, amount: string, asset: string, options: TransferOptions = {}): Promise<PreparedTransfer> {
        const { estimate, transaction } = await this.buildTransfer(from.address, to, amount, asset, options);
        this.checkFeeLimit(BigInt(estimate.fee.baseUnits), options.maxFeeBaseUnits);
        const rawTransaction = await privateKeyToAccount(this.formatPrivateKey(from.privateKey)).signTransaction(transaction);
        return { ...estimate, transactionHash: keccak256(rawTransaction), rawTransaction };
    }

    async getTransactionStatus(transactionHash: string): Promise<TransactionStatus> {
        const hash = transactionHash as Hex;
        const receipt = await this.client.getTransactionReceipt({ hash }).catch(missingTransaction);
        if (receipt) {
            return {
                state: receipt.status === 'reverted' ? 'failed' : 'confirmed',
                transactionHash
            };
        }

        const transaction = await this.client.getTransaction({ hash }).catch(missingTransaction);
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
            privateKeyToAccount(this.formatPrivateKey(privateKey));
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
            const formatted = this.formatPrivateKey(privateKey);
            return { address: privateKeyToAccount(formatted).address, privateKey: formatted };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid private key: ${message}`);
        }
    }

    async createAccount(): Promise<WalletAccount> {
        const privateKey = generatePrivateKey();
        return { address: privateKeyToAccount(privateKey).address, privateKey };
    }

    async accountFromMnemonic(mnemonic: string): Promise<WalletAccount> {
        const seed = await bip39.mnemonicToSeed(mnemonic);
        const addrNode = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
        if (!addrNode.privateKey) {
            throw new Error('Mnemonic derivation produced no private key');
        }
        const privateKey = toHex(addrNode.privateKey);
        return { address: privateKeyToAccount(privateKey).address, privateKey, mnemonic };
    }

    async createAccountFromMnemonic(wordCount: 12 | 24 = 12): Promise<WalletAccount> {
        try {
            const strength = wordCount === 24 ? 256 : 128;
            const mnemonic = bip39.generateMnemonic(wordlist, strength);
            return this.accountFromMnemonic(mnemonic);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error('Failed to create account from mnemonic: ' + message);
        }
    }

    validateMnemonic(mnemonic: string): boolean {
        return bip39.validateMnemonic(mnemonic, wordlist);
    }

    async sendSignedTransaction(signedTx: SignedTransaction | string): Promise<unknown> {
        const rawTransaction = typeof signedTx === 'string' ? signedTx : signedTx.rawTransaction;
        if (!rawTransaction) {
            throw new Error('Signed transaction rawTransaction is required.');
        }
        const hash = await this.client.sendRawTransaction({ serializedTransaction: rawTransaction as Hex });
        const receipt = await this.client.waitForTransactionReceipt({ hash });

        if (receipt.status === 'reverted') {
            throw new Error('Transaction was mined but reverted.');
        }
        return receipt;
    }
}

function missingTransaction(error: unknown): undefined {
    if (error instanceof TransactionReceiptNotFoundError || error instanceof TransactionNotFoundError) return undefined;
    throw error;
}
