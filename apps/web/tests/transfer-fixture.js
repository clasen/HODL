import { createRequire } from 'node:module';
import { createDecipheriv, pbkdf2Sync, createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { webConfig } from '../config.mjs';
import { MAIN, PASSWORD, PHRASE, EVM_FROM, BTC_FROM, answer, choose, confirm, prompt, shown, importPhrase, switchNetwork, unlock } from './terminal.js';

const require = createRequire(import.meta.resolve('hodl-wallet'));
const { Web3 } = require('web3');
const bitcoin = require('bitcoinjs-lib');
export { PASSWORD, PHRASE, EVM_FROM, BTC_FROM };
export const EVM_TO = '0x1111111111111111111111111111111111111111';
export const BTC_TO = 'bc1qyl7wjm2ldfezgnjk2c78adqlk7dvtm8sd7gn0q';

export async function storedTransfers(page) {
    const envelope = await page.evaluate(config => new Promise((resolve, reject) => {
        const request = indexedDB.open(config.database, config.databaseVersion);
        request.onerror = () => reject(new Error('Storage unavailable'));
        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(config.store, 'readonly');
            const get = tx.objectStore(config.store).get(config.record);
            tx.oncomplete = () => { db.close(); resolve(get.result); };
        };
    }), webConfig.vault);
    const { ciphertext, ...header } = envelope;
    const bytes = Buffer.from(ciphertext, 'base64');
    const key = pbkdf2Sync(PASSWORD, Buffer.from(header.kdf.salt, 'base64'), header.kdf.iterations, 32, 'sha256');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.cipher.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(header)));
    decipher.setAuthTag(bytes.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
    try { return Object.values(JSON.parse(plaintext.toString()).sendRequest ?? {}); }
    finally { plaintext.fill(0); key.fill(0); }
}

export const importFixture = page => importPhrase(page);

export const unlockFixture = page => unlock(page);

/** Answers the shared Transfer Funds prompts up to the amount. */
export async function fillTransfer(page, { to, amount = '0.1', asset = 'BNB', tokens = true }) {
    await choose(page, MAIN, 'Transfer Funds');
    await answer(page, 'Recipient address:', to);
    if (tokens) await choose(page, 'Token to transfer:', asset);
    await answer(page, 'Amount to transfer (or max):', amount);
}

/** Reaches the host's review of a transfer and the confirmation that follows it. */
export async function reviewTransfer(page, network = 'bsc', amount = '0.1', asset = 'BNB') {
    if (network !== 'btc') await switchNetwork(page, network);
    await fillTransfer(page, { to: network === 'btc' ? BTC_TO : EVM_TO, amount, asset, tokens: network !== 'btc' });
    await expect(prompt(page, 'Confirm transfer of')).toBeVisible();
    await shown(page, 'Review transfer');
}

export const sendTransfer = page => confirm(page, 'Confirm transfer of');

export async function mockNetworks(context, page) {
    const previous = new bitcoin.Transaction();
    previous.addInput(Buffer.alloc(32, 1), 0);
    previous.addOutput(bitcoin.address.toOutputScript(BTC_FROM), 2000000);
    const state = { page, gasPrice: 1000000000n, balance: 10000000000000000000n, status: 'confirmed', mode: 'success',
        hashes: [], methods: [], unexpected: [], gate: undefined, beforeBroadcast: undefined };
    const inspect = async (raw, hash) => {
        const transfers = await storedTransfers(state.page);
        const stored = transfers.find(transfer => transfer.transactionHash === hash);
        expect(stored?.state).toBe('broadcasting');
        expect(createHash('sha256').update(stored.rawTransaction).digest('hex') === createHash('sha256').update(raw).digest('hex')).toBe(true);
        state.hashes.push(hash);
        await state.beforeBroadcast?.();
    };
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1') return route.continue();
        if (url.hostname === 'bsc-dataseed1.binance.org') {
            const request = route.request().postDataJSON();
            state.methods.push(request.method);
            let result;
            switch (request.method) {
                case 'eth_chainId': result = '0x38'; break;
                case 'eth_getBalance': result = '0x' + state.balance.toString(16); break;
                case 'eth_gasPrice': result = '0x' + state.gasPrice.toString(16); break;
                case 'eth_getTransactionCount': result = '0x0'; break;
                case 'eth_estimateGas':
                    await state.gate?.();
                    result = request.params[0].data ? '0xfde8' : '0x5208'; break;
                case 'eth_call': {
                    const data = request.params[0].data ?? '';
                    result = data.startsWith('0x313ce567') ? '0x' + (18).toString(16).padStart(64, '0')
                        : data.startsWith('0x70a08231') ? '0x' + state.balance.toString(16).padStart(64, '0') : '0x';
                    break;
                }
                case 'eth_sendRawTransaction':
                    result = Web3.utils.keccak256(request.params[0]);
                    await inspect(request.params[0], result);
                    if (route.request().frame().page().isClosed()) return;
                    if (state.mode === 'lost') return route.abort();
                    break;
                case 'eth_blockNumber': result = '0x10'; break;
                case 'eth_getTransactionReceipt':
                    result = !state.hashes.length || state.status === 'not_found' || state.status === 'submitted' ? null : {
                        transactionHash: request.params[0], transactionIndex: '0x0', blockHash: '0x' + 'b'.repeat(64),
                        blockNumber: '0x10', from: EVM_FROM, to: EVM_TO, cumulativeGasUsed: '0x5208', gasUsed: '0x5208',
                        contractAddress: null, logs: [], logsBloom: '0x' + '0'.repeat(512), status: state.status === 'failed' ? '0x0' : '0x1',
                        effectiveGasPrice: '0x3b9aca00', type: '0x0'
                    }; break;
                case 'eth_getTransactionByHash':
                    result = state.status === 'not_found' ? null : { hash: request.params[0], nonce: '0x0', from: EVM_FROM, to: EVM_TO,
                        value: '0x0', gas: '0x5208', gasPrice: '0x3b9aca00', input: '0x', blockHash: null, blockNumber: null, transactionIndex: null };
                    break;
                default: state.unexpected.push(request.method); return route.abort();
            }
            return route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result } });
        }
        if (url.hostname === 'blockstream.info') {
            if (url.pathname.endsWith('/utxo')) return route.fulfill({ json: [{ txid: previous.getId(), vout: 0, value: 2000000, status: { confirmed: true } }] });
            if (url.pathname.startsWith('/api/address/')) return route.fulfill({ json: { chain_stats: { funded_txo_sum: 2000000, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } } });
            if (url.pathname === `/api/tx/${previous.getId()}/hex`) return route.fulfill({ body: previous.toHex() });
            if (url.pathname === '/api/tx' && route.request().method() === 'POST') {
                const raw = route.request().postData();
                const hash = bitcoin.Transaction.fromHex(raw).getId();
                await inspect(raw, hash);
                if (route.request().frame().page().isClosed()) return;
                if (state.mode === 'lost') return route.abort();
                return route.fulfill({ body: hash });
            }
            if (url.pathname.endsWith('/status')) return state.status === 'not_found'
                ? route.fulfill({ status: 404, body: 'Not found' }) : route.fulfill({ json: { confirmed: state.status === 'confirmed' } });
        }
        return route.abort();
    });
    return state;
}
