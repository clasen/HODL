import BaseNetwork from './BaseNetwork.js';
import * as bitcoin from 'bitcoinjs-lib';
import bip39 from 'bip39';
import * as ecc from 'tiny-secp256k1';
import { BIP32Factory } from 'bip32';
import { ECPairFactory } from 'ecpair';
import axios from 'axios';

const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);

export default class BitcoinNetwork extends BaseNetwork {
    constructor(config) {
        super();
        this.config = config;
        this.network = bitcoin.networks[config.network || 'bitcoin'];
        this.url = config.url;
    }

    async getBalance(address) {
        try {
            const response = await axios.get(`${this.url}/address/${address}`);
            const chainStats = response.data.chain_stats;
            const mempoolStats = response.data.mempool_stats;
            const balance = (chainStats.funded_txo_sum - chainStats.spent_txo_sum) +
                (mempoolStats.funded_txo_sum - mempoolStats.spent_txo_sum);
            return this.satoshisToBTC(balance);
        } catch (error) {
            throw new Error(`Failed to get balance: ${error.message}`);
        }
    }

    async getTokenBalance(address, tokenSymbol) {
        if (tokenSymbol === this.config.nativeToken) {
            return await this.getBalance(address);
        }
        throw new Error(`Token ${tokenSymbol} not supported on Bitcoin network`);
    }

    async transfer(from, to, amount, options = {}) {
        try {
            const utxos = await this.getUTXOs(from.address);
            const satoshis = this.BTCToSatoshis(amount); // Regular number, not BigInt
            const feeRate = options.feeRate || 10; // sats/byte

            // Create PSBT instance with network
            const psbt = new bitcoin.Psbt({ network: this.network });
            psbt.setVersion(2);
            psbt.setLocktime(0);

            let totalInputValue = 0;

            // Add inputs
            for (const utxo of utxos) {
                // Get the full transaction for nonWitnessUtxo
                const txHex = await this.getTransaction(utxo.txid);

                psbt.addInput({
                    hash: utxo.txid,
                    index: utxo.vout,
                    nonWitnessUtxo: Buffer.from(txHex, 'hex'),
                    sequence: 0xffffffff
                });

                totalInputValue += utxo.value;

                // Break if we have enough funds (considering estimated fee)
                const estimatedFee = this.estimateTxSize(psbt.inputCount, 2) * feeRate;
                if (totalInputValue >= satoshis + estimatedFee) {
                    break;
                }
            }

            if (totalInputValue < satoshis + feeRate) {
                throw new Error('Insufficient balance for the transaction including fees.');
            }

            // Add recipient output
            psbt.addOutput({
                address: to,
                value: satoshis
            });

            // Add change output if needed
            const estimatedFee = this.estimateTxSize(psbt.inputCount, 2) * feeRate;
            const changeValue = totalInputValue - satoshis - estimatedFee;
            if (changeValue > 546) { // Dust threshold
                psbt.addOutput({
                    address: from.address,
                    value: changeValue
                });
            }

            // Sign all inputs
            const keyPair = ECPair.fromWIF(from.privateKey, this.network);
            for (let i = 0; i < psbt.inputCount; i++) {
                psbt.signInput(i, keyPair);

                // Validate signature
                const valid = psbt.validateSignaturesOfInput(i, (pubkey, msghash, signature) => {
                    return ECPair.fromPublicKey(pubkey).verify(msghash, signature);
                });

                if (!valid) {
                    throw new Error(`Signature validation failed for input ${i}`);
                }
            }

            // Finalize and extract transaction
            psbt.finalizeAllInputs();
            return psbt.extractTransaction().toHex();

        } catch (error) {
            throw new Error(`Failed to create transaction: ${error.message}`);
        }
    }

    // Add this helper method to get full transaction data
    async getTransaction(txid) {
        try {
            const response = await axios.get(`${this.url}/tx/${txid}/hex`);
            return response.data;
        } catch (error) {
            throw new Error(`Failed to get transaction: ${error.message}`);
        }
    }

    // Método para estimar el tamaño de la transacción
    estimateTxSize(numInputs, numOutputs) {
        return numInputs * 68 + numOutputs * 31 + 10; // Aproximación para P2WPKH
    }

    // Helper function to create account details from a key pair
    createAccountDetails(keyPair) {
        const { address } = bitcoin.payments.p2wpkh({
            pubkey: keyPair.publicKey,
            network: this.network
        });

        return {
            address,
            privateKey: keyPair.toWIF(),
            publicKey: keyPair.publicKey.toString('hex')
        };
    }

    async createAccount() {
        const keyPair = ECPair.makeRandom({ network: this.network });
        return this.createAccountDetails(keyPair);
    }

    privateKeyToAccount(privateKeyWIF) {
        try {
            const keyPair = ECPair.fromWIF(privateKeyWIF, this.network);
            return this.createAccountDetails(keyPair);
        } catch (error) {
            throw new Error(`Failed to derive account from private key: ${error.message}`);
        }
    }

    async accountFromMnemonic(mnemonic) {
        const seed = await bip39.mnemonicToSeed(mnemonic);
        const root = bip32.fromSeed(seed, this.network);
        const path = `m/84'/0'/0'/0/0`; // BIP84 para SegWit nativo
        const child = root.derivePath(path);

        // Convert Uint8Array to Buffer if needed
        const privateKeyBuffer = Buffer.isBuffer(child.privateKey) 
            ? child.privateKey 
            : Buffer.from(child.privateKey);
        
        // Create ECPair from the private key buffer
        const keyPair = ECPair.fromPrivateKey(privateKeyBuffer, { network: this.network });
        
        const { address } = bitcoin.payments.p2wpkh({
            pubkey: keyPair.publicKey,
            network: this.network
        });

        return {
            address,
            privateKey: keyPair.toWIF(),
            publicKey: keyPair.publicKey.toString('hex'),
            mnemonic
        };
    }

    async createAccountFromMnemonic(wordCount = 12) {
        try {
            // Support both 12 and 24 word mnemonics
            const strength = wordCount === 24 ? 256 : 128; // 256 bits = 24 words, 128 bits = 12 words
            const mnemonic = bip39.generateMnemonic(strength);
            return this.accountFromMnemonic(mnemonic);
        } catch (error) {
            throw new Error('Failed to create account from mnemonic: ' + error.message);
        }
    }

    validateMnemonic(mnemonic) {
        return bip39.validateMnemonic(mnemonic);
    }

    // Métodos auxiliares
    satoshisToBTC(satoshis) {
        return satoshis / 100000000;
    }

    BTCToSatoshis(btc) {
        return Math.floor(btc * 100000000);
    }

    async getUTXOs(address) {
        try {
            const response = await axios.get(`${this.url}/address/${address}/utxo`);
            return response.data;
        } catch (error) {
            throw new Error(`Failed to get UTXOs: ${error.message}`);
        }
    }

    async handleNativeTransfer(from, to, amount, options = {}) {
        return this.transfer(from, to, amount, options);
    }

    async sendSignedTransaction(signedTx) {
        try {
            const response = await axios.post(`${this.url}/tx`, signedTx);
            return { transactionHash: response.data };
        } catch (error) {
            throw new Error(`Failed to broadcast transaction: ${error.message}`);
        }
    }
} 