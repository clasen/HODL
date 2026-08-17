import BaseNetwork from './BaseNetwork.js';
import * as bitcoin from 'bitcoinjs-lib';
import bip39 from 'bip39';
import * as ecc from 'tiny-secp256k1';
import { BIP32Factory } from 'bip32';
import { ECPairFactory } from 'ecpair';
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

const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);

type BitcoinUtxo = { txid: string; vout: number; value: number };
type BitcoinBroadcastResult = { transactionHash: string };
type BitcoinTransactionStatus = { confirmed: boolean };
type BitcoinAddressStats = {
    chain_stats: {
        funded_txo_sum: number;
        spent_txo_sum: number;
    };
    mempool_stats: {
        funded_txo_sum: number;
        spent_txo_sum: number;
    };
};
type BitcoinKeyPair = {
    publicKey: Buffer | Uint8Array;
    toWIF(): string;
};

export default class BitcoinNetwork extends BaseNetwork {
    private network: bitcoin.Network;
    private url: string;

    constructor(config: NetworkConfig) {
        super(config);
        const networkName = config.network || 'bitcoin';
        this.network = networkName === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
        this.url = config.url;
    }

    validateAddress(address: string): boolean {
        try {
            bitcoin.address.toOutputScript(address, this.network);
            return true;
        } catch {
            return false;
        }
    }

    async getBalance(address: string): Promise<string> {
        return (await this.getAssetBalance(address, this.config.nativeToken)).amount;
    }

    async getAssetBalance(address: string, asset: string): Promise<AssetBalance> {
        if (asset.toUpperCase() !== this.config.nativeToken) {
            throw new Error(`Token ${asset} not supported on Bitcoin network`);
        }
        if (!this.validateAddress(address)) {
            throw new Error('Invalid Bitcoin address.');
        }

        try {
            const data = await this.fetchFromApi<BitcoinAddressStats>(`/address/${address}`);
            const chainStats = data.chain_stats;
            const mempoolStats = data.mempool_stats;
            const balance = (chainStats.funded_txo_sum - chainStats.spent_txo_sum) +
                (mempoolStats.funded_txo_sum - mempoolStats.spent_txo_sum);
            return {
                asset: this.config.nativeToken,
                amount: formatUnits(BigInt(balance), 8),
                baseUnits: balance.toString(),
                decimals: 8
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to get balance: ${message}`);
        }
    }

    async getTokenBalance(address: string, tokenSymbol: string): Promise<string> {
        if (tokenSymbol === this.config.nativeToken) {
            return await this.getBalance(address);
        }
        throw new Error(`Token ${tokenSymbol} not supported on Bitcoin network`);
    }

    async transfer(
        from: WalletAccount,
        to: string,
        amount: number | string,
        options: TransferOptions = {}
    ): Promise<string> {
        return (await this.buildTransaction(from, to, amount.toString(), options)).rawTransaction;
    }

    private async buildTransaction(
        from: WalletAccount,
        to: string,
        amount: string,
        options: TransferOptions
    ): Promise<{ rawTransaction: string; feeBaseUnits: bigint; amountBaseUnits: bigint }> {
        if (!this.validateAddress(from.address) || !this.validateAddress(to)) {
            throw new Error('Invalid Bitcoin address.');
        }

        try {
            const utxos = await this.getUTXOs(from.address);
            const amountBaseUnits = parseDecimalToUnits(amount, 8);
            if (amountBaseUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new Error('Bitcoin amount exceeds the safe transaction range.');
            }
            const satoshis = Number(amountBaseUnits);
            const feeRate = options.feeRate ?? this.config.feeRate;
            if (typeof feeRate !== 'number' || !Number.isInteger(feeRate) || feeRate <= 0) {
                throw new Error('Bitcoin fee rate must be configured as a positive integer.');
            }

            const psbt = new bitcoin.Psbt({ network: this.network });
            psbt.setVersion(2);
            psbt.setLocktime(0);

            let totalInputValue = 0;

            for (const utxo of utxos) {
                const txHex = await this.getTransaction(utxo.txid);

                psbt.addInput({
                    hash: utxo.txid,
                    index: utxo.vout,
                    nonWitnessUtxo: Buffer.from(txHex, 'hex'),
                    sequence: 0xffffffff
                });

                totalInputValue += utxo.value;

                const estimatedFee = this.estimateTxSize(psbt.inputCount, 2) * feeRate;
                if (totalInputValue >= satoshis + estimatedFee) {
                    break;
                }
            }

            const estimatedFee = this.estimateTxSize(psbt.inputCount, 2) * feeRate;
            if (totalInputValue < satoshis + estimatedFee) {
                throw new Error('Insufficient balance for the transaction including fees.');
            }

            psbt.addOutput({
                address: to,
                value: satoshis
            });

            const changeValue = totalInputValue - satoshis - estimatedFee;
            let returnedChange = 0;
            if (changeValue > 546) {
                psbt.addOutput({
                    address: from.address,
                    value: changeValue
                });
                returnedChange = changeValue;
            }

            const keyPair = ECPair.fromWIF(from.privateKey, this.network);
            for (let i = 0; i < psbt.inputCount; i++) {
                psbt.signInput(i, keyPair);

                const valid = psbt.validateSignaturesOfInput(i, (pubkey, msghash, signature) => {
                    return ECPair.fromPublicKey(pubkey).verify(msghash, signature);
                });

                if (!valid) {
                    throw new Error(`Signature validation failed for input ${i}`);
                }
            }

            psbt.finalizeAllInputs();
            return {
                rawTransaction: psbt.extractTransaction().toHex(),
                feeBaseUnits: BigInt(totalInputValue - satoshis - returnedChange),
                amountBaseUnits
            };

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to create transaction: ${message}`);
        }
    }

    async prepareTransfer(
        from: WalletAccount,
        to: string,
        amount: string,
        asset: string,
        options: TransferOptions = {}
    ): Promise<PreparedTransfer> {
        if (asset.toUpperCase() !== this.config.nativeToken) {
            throw new Error(`Token ${asset} not supported on Bitcoin network`);
        }

        const built = await this.buildTransaction(from, to, amount, options);
        const transaction = bitcoin.Transaction.fromHex(built.rawTransaction);

        return {
            from: from.address,
            to,
            asset: this.config.nativeToken,
            amount: formatUnits(built.amountBaseUnits, 8),
            amountBaseUnits: built.amountBaseUnits.toString(),
            fee: {
                asset: this.config.nativeToken,
                amount: formatUnits(built.feeBaseUnits, 8),
                baseUnits: built.feeBaseUnits.toString(),
                decimals: 8,
                estimated: true
            },
            transactionHash: transaction.getId(),
            rawTransaction: built.rawTransaction
        };
    }

    async getTransaction(txid: string): Promise<string> {
        try {
            return await this.fetchFromApi(`/tx/${txid}/hex`, {}, 'text');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to get transaction: ${message}`);
        }
    }

    estimateTxSize(numInputs: number, numOutputs: number): number {
        return numInputs * 68 + numOutputs * 31 + 10;
    }

    createAccountDetails(keyPair: BitcoinKeyPair): WalletAccount {
        const { address } = bitcoin.payments.p2wpkh({
            pubkey: Buffer.from(keyPair.publicKey),
            network: this.network
        });

        if (!address) {
            throw new Error('Failed to derive Bitcoin address.');
        }

        return {
            address,
            privateKey: keyPair.toWIF(),
            publicKey: Buffer.from(keyPair.publicKey).toString('hex')
        };
    }

    async createAccount(): Promise<WalletAccount> {
        const keyPair = ECPair.makeRandom({ network: this.network });
        return this.createAccountDetails(keyPair);
    }

    validatePrivateKey(privateKeyWIF: string): boolean {
        try {
            ECPair.fromWIF(privateKeyWIF, this.network);
            return true;
        } catch {
            return false;
        }
    }

    async privateKeyToAccount(privateKeyWIF: string): Promise<WalletAccount> {
        try {
            const keyPair = ECPair.fromWIF(privateKeyWIF, this.network);
            return this.createAccountDetails(keyPair);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to derive account from private key: ${message}`);
        }
    }

    async accountFromMnemonic(mnemonic: string): Promise<WalletAccount> {
        const seed = await bip39.mnemonicToSeed(mnemonic);
        const root = bip32.fromSeed(seed, this.network);
        const path = `m/84'/0'/0'/0/0`;
        const child = root.derivePath(path);

        if (!child.privateKey) {
            throw new Error('Failed to derive Bitcoin private key from mnemonic.');
        }

        const privateKeyBuffer = Buffer.isBuffer(child.privateKey) 
            ? child.privateKey 
            : Buffer.from(child.privateKey);
        
        const keyPair = ECPair.fromPrivateKey(privateKeyBuffer, { network: this.network });
        
        const { address } = bitcoin.payments.p2wpkh({
            pubkey: keyPair.publicKey,
            network: this.network
        });

        if (!address) {
            throw new Error('Failed to derive Bitcoin address from mnemonic.');
        }

        return {
            address,
            privateKey: keyPair.toWIF(),
            publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
            mnemonic
        };
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

    satoshisToBTC(satoshis: number): string {
        return formatUnits(BigInt(satoshis), 8);
    }

    BTCToSatoshis(btc: number | string): number {
        const units = parseDecimalToUnits(btc.toString(), 8);
        if (units > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('Bitcoin amount exceeds the safe transaction range.');
        }
        return Number(units);
    }

    async getUTXOs(address: string): Promise<BitcoinUtxo[]> {
        try {
            return await this.fetchFromApi<BitcoinUtxo[]>(`/address/${address}/utxo`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to get UTXOs: ${message}`);
        }
    }

    async handleNativeTransfer(
        from: WalletAccount,
        to: string,
        amount: number | string,
        options: TransferOptions = {}
    ): Promise<string> {
        return this.transfer(from, to, amount, options);
    }

    async sendSignedTransaction(signedTx: SignedTransaction | string): Promise<BitcoinBroadcastResult> {
        const rawTransaction = typeof signedTx === 'string' ? signedTx : signedTx.rawTransaction;
        if (!rawTransaction) {
            throw new Error('Signed transaction rawTransaction is required.');
        }

        try {
            const txHash = await this.fetchFromApi(
                '/tx',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/plain'
                    },
                    body: rawTransaction
                },
                'text'
            );
            return { transactionHash: txHash };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to broadcast transaction: ${message}`);
        }
    }

    async getTransactionStatus(transactionHash: string): Promise<TransactionStatus> {
        const response = await fetch(`${this.url}/tx/${transactionHash}/status`);
        if (response.status === 404) {
            return { state: 'not_found', transactionHash };
        }
        if (!response.ok) {
            throw new Error(`Failed to get transaction status: ${response.status} ${response.statusText}`);
        }

        const status = await response.json() as BitcoinTransactionStatus;
        return {
            state: status.confirmed ? 'confirmed' : 'submitted',
            transactionHash
        };
    }

    async fetchFromApi(path: string, options: RequestInit | undefined, responseType: 'text'): Promise<string>;
    async fetchFromApi<T>(path: string, options?: RequestInit, responseType?: 'json'): Promise<T>;
    async fetchFromApi<T>(
        path: string,
        options: RequestInit = {},
        responseType: 'json' | 'text' = 'json'
    ): Promise<T | string> {
        const response = await fetch(`${this.url}${path}`, options);

        if (!response.ok) {
            const errorBody = await response.text();
            const details = errorBody ? ` - ${errorBody}` : '';
            throw new Error(`${response.status} ${response.statusText}${details}`);
        }

        return responseType === 'text' ? response.text() : response.json();
    }

    async transferToken(): Promise<never> {
        throw new Error('Tokens are not supported on Bitcoin network');
    }

    async estimateGas(): Promise<never> {
        throw new Error('Gas estimation is not supported on Bitcoin network');
    }

    async getGasPrice(): Promise<never> {
        throw new Error('Gas price is not supported on Bitcoin network');
    }
} 
