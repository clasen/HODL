import BaseNetwork from './BaseNetwork.js';
import * as bitcoin from 'bitcoinjs-lib';
import bip39 from 'bip39';
import * as ecc from 'tiny-secp256k1';
import { BIP32Factory } from 'bip32';
import axios from 'axios';

const bip32 = BIP32Factory(ecc);

export default class BTCNetwork extends BaseNetwork {
    constructor(config) {
        super();
        this.config = config;
        this.network = bitcoin.networks[config.network || 'bitcoin'];
        this.apiUrl = config.apiUrl; // Por ejemplo: blockchain.info API o blockstream API
    }

    async getBalance(address) {
        try {
            const response = await axios.get(`${this.apiUrl}/address/${address}`);
            const chainStats = response.data.chain_stats;
            const mempoolStats = response.data.mempool_stats;
            const balance = (chainStats.funded_txo_sum - chainStats.spent_txo_sum) +
                (mempoolStats.funded_txo_sum - mempoolStats.spent_txo_sum);
            return this.satoshisToBTC(balance);
        } catch (error) {
            throw new Error(`Failed to get balance: ${error.message}`);
        }
    }


    async getTokenBalances(address) {
        const balances = [];

        const nativeBalance = await this.getBalance(address);
        balances.push([this.config.nativeToken, nativeBalance]);

        return balances;
    }

    async transfer(from, to, amount, options = {}) {
        try {
            const utxos = await this.getUTXOs(from.address);
            const satoshis = BigInt(this.BTCToSatoshis(amount));
            const feeRate = options.feeRate || 10; // sats/byte

            // Ordenar UTXOs por valor ascendente
            utxos.sort((a, b) => a.value - b.value);

            let inputs = [];
            let totalInputValue = 0n;
            let estimatedFee = 0n;

            // Seleccionar UTXOs hasta cubrir el monto y las tarifas
            for (const utxo of utxos) {
                inputs.push(utxo);
                totalInputValue += BigInt(utxo.value);

                // Estimar la tarifa
                const numInputs = inputs.length;
                const numOutputs = 2; // Asumimos que habrá un cambio
                const txSize = this.estimateTxSize(numInputs, numOutputs);
                estimatedFee = BigInt(txSize * feeRate);

                if (totalInputValue >= satoshis + estimatedFee) {
                    break;
                }
            }

            if (totalInputValue < satoshis + estimatedFee) {
                throw new Error('Insufficient balance for the transaction including fees.');
            }

            const changeValue = totalInputValue - satoshis - estimatedFee;
            const psbt = new bitcoin.Psbt({ network: this.network });

            // Agregar inputs
            for (const utxo of inputs) {
                psbt.addInput({
                    hash: utxo.txid,
                    index: utxo.vout,
                    witnessUtxo: {
                        script: bitcoin.address.toOutputScript(from.address, this.network),
                        value: BigInt(utxo.value)
                    }
                });
            }

            // Agregar output principal
            psbt.addOutput({
                address: to,
                value: satoshis
            });

            // Agregar output de cambio si es necesario
            if (changeValue > 546n) { // Umbral de polvo
                psbt.addOutput({
                    address: from.address,
                    value: changeValue
                });
            }

            const privateKey = this.WIFToPrivateKey(from.privateKey);
            for (let i = 0; i < psbt.data.inputs.length; i++) {
                psbt.signInput(i, {
                    publicKey: ecc.pointFromScalar(privateKey),
                    sign: (hash) => {
                        return Buffer.from(ecc.sign(hash, privateKey));
                    }
                });
            }

            // Validar firmas
            psbt.validateSignaturesOfAllInputs();

            psbt.finalizeAllInputs();

            const txHex = psbt.extractTransaction().toHex();

            return txHex;

        } catch (error) {
            throw new Error(`Failed to create transaction: ${error.message}`);
        }
    }

    // Método para estimar el tamaño de la transacción
    estimateTxSize(numInputs, numOutputs) {
        return numInputs * 68 + numOutputs * 31 + 10; // Aproximación para P2WPKH
    }


    async createAccount() {
        const privateKey = bitcoin.crypto.randomBytes(32);
        const publicKey = ecc.pointFromScalar(privateKey);
        const { address } = bitcoin.payments.p2wpkh({
            pubkey: Buffer.from(publicKey),
            network: this.network
        });

        return {
            address,
            privateKey: this.privateKeyToWIF(privateKey),
            publicKey: Buffer.from(publicKey).toString('hex')
        };
    }

    async accountFromMnemonic(mnemonic) {
        const seed = await bip39.mnemonicToSeed(mnemonic);
        const root = bip32.fromSeed(seed, this.network);
        const path = `m/84'/0'/0'/0/0`; // BIP84 para SegWit nativo
        const child = root.derivePath(path);

        const { address } = bitcoin.payments.p2wpkh({
            pubkey: child.publicKey,
            network: this.network
        });

        return {
            address,
            privateKey: child.toWIF(),
            publicKey: child.publicKey.toString('hex'),
            mnemonic
        };
    }

    async createAccountFromMnemonic() {
        try {
            const mnemonic = bip39.generateMnemonic();
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
            const response = await axios.get(`${this.apiUrl}/address/${address}/utxo`);
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
            const response = await axios.post(`${this.apiUrl}/tx`, signedTx);
            return response.data;
        } catch (error) {
            throw new Error(`Failed to broadcast transaction: ${error.message}`);
        }
    }

    privateKeyToWIF(privateKey) {
        const version = this.network === bitcoin.networks.testnet ? 0xef : 0x80;
        const keyWithVersion = Buffer.concat([
            Buffer.from([version]),
            privateKey,
            Buffer.from([0x01]) // compressed
        ]);
        const checksum = bitcoin.crypto.hash256(keyWithVersion).slice(0, 4);
        return bitcoin.address.toBase58Check(keyWithVersion, checksum);
    }

    WIFToPrivateKey(wif) {
        try {
            const decoded = bitcoin.address.fromBase58Check(wif);
            // Check if the decoded length is correct (1 version byte + 32 bytes key + 1 compression byte)
            if (decoded.hash.length !== 33) {
                throw new Error('Invalid WIF format.');
            }
            // Extract the private key (first 32 bytes)
            return decoded.hash.slice(0, 32);
        } catch (error) {
            throw new Error(`Invalid WIF private key: ${error.message}`);
        }
    }
} 