import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Persist from '../persist.js';
import { TransferService } from '../transfer-service.js';
import { WalletService } from '../wallet-service.js';
import { NetworkRegistry } from '../network-registry.js';
import BitcoinNetwork from '../network/lib/BitcoinNetwork.js';
import btc from '../network/btc.js';
import type { NetworkPlugin, PreparedTransfer, TransactionStatus, WalletAccount } from '../network/types.js';

const FROM = 'bc1qyl7wjm2ldfezgnjk2c78adqlk7dvtm8sd7gn0q';
const request = { wallet: 'default', to: FROM, asset: 'BTC', amount: '0.001', dryRun: false, requestId: 'test-send' };

async function fixture(family: 'bitcoin' | 'evm' = 'bitcoin') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hodl-transfer-'));
    const state = {
        signs: 0, broadcasts: [] as string[], failBroadcast: false, failStatus: false,
        status: 'not_found' as TransactionStatus['state']
    };
    class FakeNetwork extends BitcoinNetwork {
        async prepareTransfer(from: WalletAccount, to: string, amount: string, asset: string): Promise<PreparedTransfer> {
            state.signs++;
            return {
                from: from.address, to, amount, asset, amountBaseUnits: '100000',
                fee: { asset: 'BTC', amount: '0.00001', baseUnits: '1000', decimals: 8, estimated: true },
                rawTransaction: `signed-fixture-${state.signs}`, transactionHash: String(state.signs).padStart(64, '0')
            };
        }
        async sendSignedTransaction(raw: string) {
            const data = Persist.decrypt(fs.readFileSync(path.join(directory, 'persist.json'), 'utf8'), 'fixture-password') as any;
            const stored = Object.values(data.sendRequest).find((value: any) => value.rawTransaction === raw) as any;
            assert.equal(stored.state, 'broadcasting');
            assert.equal(fs.statSync(path.join(directory, 'persist.json')).mode & 0o777, 0o600);
            state.broadcasts.push(raw);
            if (state.failBroadcast) throw new Error('Response lost after submission');
            return { transactionHash: stored.transactionHash };
        }
        async getTransactionStatus(transactionHash: string): Promise<TransactionStatus> {
            if (state.failStatus) throw new Error('RPC unavailable');
            return { state: state.status, transactionHash };
        }
    }
    const plugin: NetworkPlugin = { ...btc, id: family === 'evm' ? 'bsc' : 'btc', family, NetworkClass: FakeNetwork };
    let db = new Persist({ path: directory, encryptionKey: 'fixture-password' });
    await db.connect();
    await db.set('account', FakeNetwork.name, { address: FROM, privateKey: 'fixture-only-key' });
    return {
        directory, state, plugin,
        get db() { return db; },
        service() { return new TransferService(db, plugin, new FakeNetwork(plugin)); },
        wallet() { return new WalletService({ rootDir: directory, registry: new NetworkRegistry([plugin]) }); },
        async reopen() {
            await db.dispose();
            db = new Persist({ path: directory, encryptionKey: 'fixture-password' });
            await db.connect();
        },
        async close() { await db.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
    };
}

test('submitted Bitcoin transaction is refreshed through the CLI service without signing or broadcasting again', async () => {
    const f = await fixture();
    try {
        const result = await f.service().send(request);
        assert.equal(result.status, 'submitted');
        await f.db.dispose();
        f.state.status = 'confirmed';
        const updated = await f.wallet().send({ ...request, password: 'fixture-password', network: 'btc' });
        assert.equal(updated.status, 'confirmed');
        assert.equal(updated.transactionHash, result.transactionHash);
        assert.equal(f.state.signs, 1);
        assert.equal(f.state.broadcasts.length, 1);
    } finally { await f.close(); }
});

test('lost response is recoverable across restart, blocks another payment and reuses the signed bytes', async () => {
    const f = await fixture();
    try {
        f.state.failBroadcast = true;
        await assert.rejects(f.service().send(request), { code: 'BROADCAST_UNKNOWN' });
        await f.reopen();
        const [saved] = await f.service().list();
        assert.equal(saved.status, 'broadcast_unknown');
        assert.equal('rawTransaction' in saved, false);
        await assert.rejects(f.service().send({ ...request, requestId: 'another-payment' }), { code: 'BROADCAST_UNKNOWN' });
        await assert.rejects(f.service().send({ ...request, amount: '0.002' }), { code: 'IDEMPOTENCY_CONFLICT' });
        f.state.failBroadcast = false;
        assert.equal((await f.service().send(request)).status, 'submitted');
        assert.equal(f.state.signs, 1);
        assert.deepEqual(f.state.broadcasts, ['signed-fixture-1', 'signed-fixture-1']);
    } finally { await f.close(); }
});

test('a transaction already found on chain is not broadcast again after a lost response', async () => {
    const f = await fixture();
    try {
        f.state.failBroadcast = true;
        await assert.rejects(f.service().send(request), { code: 'BROADCAST_UNKNOWN' });
        await f.reopen();
        f.state.status = 'confirmed';
        assert.equal((await f.service().send(request)).status, 'confirmed');
        assert.equal(f.state.broadcasts.length, 1);
    } finally { await f.close(); }
});

test('status errors and missing submitted transactions preserve the record without a new broadcast', async () => {
    const f = await fixture();
    try {
        await f.service().send(request);
        f.state.failStatus = true;
        await assert.rejects(f.service().send(request), { code: 'NETWORK_ERROR' });
        f.state.failStatus = false;
        await assert.rejects(f.service().send(request), { code: 'BROADCAST_UNKNOWN' });
        assert.equal((await f.service().list())[0].status, 'submitted');
        f.state.status = 'submitted';
        assert.equal((await f.service().send(request)).status, 'submitted');
        assert.equal(f.state.signs, 1);
        assert.equal(f.state.broadcasts.length, 1);
    } finally { await f.close(); }
});

test('an EVM transaction found pending after timeout can later be recorded as reverted', async () => {
    const f = await fixture('evm');
    try {
        f.state.failBroadcast = true;
        f.state.status = 'submitted';
        assert.equal((await f.service().send(request)).status, 'submitted');
        f.state.status = 'failed';
        await assert.rejects(f.service().send(request), { code: 'TRANSFER_FAILED' });
        await f.reopen();
        await assert.rejects(f.service().send(request), { code: 'TRANSFER_FAILED' });
        assert.equal(f.state.broadcasts.length, 1);
    } finally { await f.close(); }
});

test('storage failure before publication never broadcasts and the saved transaction remains recoverable', async () => {
    const f = await fixture();
    try {
        const flush = f.db.flush.bind(f.db);
        f.db.flush = async () => { throw new Error('Disk unavailable'); };
        await assert.rejects(f.service().send(request), /Disk unavailable/);
        assert.equal(f.state.broadcasts.length, 0);
        f.db.flush = flush;
        await f.reopen();
        assert.equal((await f.service().send(request)).status, 'submitted');
        assert.equal(f.state.signs, 1);
    } finally { await f.close(); }
});

test('a crash after publication but before saving its result can be reconciled from broadcasting', async () => {
    const f = await fixture();
    try {
        const set = f.db.set.bind(f.db);
        f.db.set = async (...args: any[]) => {
            if (args[0] === 'sendRequest' && args[2]?.state === 'submitted') throw new Error('Disk unavailable');
            return set(...args);
        };
        await assert.rejects(f.service().send(request), /Disk unavailable/);
        f.db.set = set;
        await f.reopen();
        assert.equal((await f.service().list())[0].status, 'broadcasting');
        f.state.status = 'confirmed';
        assert.equal((await f.service().send(request)).status, 'confirmed');
        assert.equal(f.state.broadcasts.length, 1);
    } finally { await f.close(); }
});

test('existing sendRequest fingerprints and records remain reusable without migration', async () => {
    const f = await fixture();
    try {
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
            wallet: 'default', network: 'btc', chainId: null, from: FROM, to: FROM, asset: 'BTC', amount: '0.001'
        })).digest('hex');
        await f.db.set('sendRequest', request.requestId, {
            fingerprint, state: 'submitted', network: 'btc', from: FROM, to: FROM, asset: 'BTC',
            amount: '0.001', amountBaseUnits: '100000', fee: {}, transactionHash: 'a'.repeat(64),
            rawTransaction: 'existing-fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        });
        f.state.status = 'confirmed';
        assert.equal((await f.service().send(request)).transactionHash, 'a'.repeat(64));
        assert.equal(f.state.signs, 0);
        assert.equal(f.state.broadcasts.length, 0);
    } finally { await f.close(); }
});

test('an active BSC swap blocks a new transfer in the shared service', async () => {
    const f = await fixture('evm');
    try {
        await f.db.set('swapOperation', 'swap-test', { state: 'deposit_pending' });
        await assert.rejects(f.service().send(request), { code: 'SWAP_IN_PROGRESS' });
        assert.equal(f.state.signs, 0);
        assert.equal(f.state.broadcasts.length, 0);
    } finally { await f.close(); }
});

for (const family of ['bitcoin', 'evm'] as const) {
    for (const state of ['completed', 'partial_completed', 'refunded', 'failed']) {
        test(`${family} transfer is allowed after the blocking swap is saved as ${state}`, async () => {
            const f = await fixture(family);
            try {
                await f.db.set('swapOperation', 'blocking-swap', { state: 'deposit_pending' });
                await assert.rejects(f.service().send(request), {
                    code: 'SWAP_IN_PROGRESS', details: { requestId: 'blocking-swap' }
                });
                assert.equal(await f.db.get('sendRequest', request.requestId), null);
                assert.equal(f.state.signs, 0);
                assert.equal(f.state.broadcasts.length, 0);
                await f.db.set('swapOperation', 'blocking-swap', { state });
                await f.service().send(request);
                assert.equal(f.state.signs, 1);
                assert.equal(f.state.broadcasts.length, 1);
            } finally { await f.close(); }
        });
    }
}

test('integration runner exits with failure for FAIL results, exceptions and missing plugins', () => {
    const runner = new URL('./test-integration.js', import.meta.url);
    for (const scenario of ['fail', 'throw', 'empty', 'pass']) {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
            import { fileURLToPath } from 'node:url';
            import { NetworkTester } from ${JSON.stringify(new URL('./test.js', import.meta.url).href)};
            const scenario = ${JSON.stringify(scenario)};
            NetworkTester.prototype.loadNetworkPlugins = async () => {
                if (scenario === 'empty') return [];
                return [{
                    name: 'Fixture', NetworkClass: { name: 'BitcoinNetwork' }, tokens: {},
                    get explorer() { if (scenario === 'throw') throw new Error('Fixture failure'); return scenario === 'fail' ? 'invalid' : 'https://example.invalid/tx/'; }
                }];
            };
            process.argv[1] = fileURLToPath(${JSON.stringify(runner.href)});
            await import(${JSON.stringify(runner.href)});
        `], { encoding: 'utf8', timeout: 20_000 });
        assert.equal(child.status, scenario === 'pass' ? 0 : 1, `${scenario}: ${child.stdout}\n${child.stderr}`);
    }
});

test('interactive transfers survive lost responses and do not report post-send errors as failed payments', () => {
    const moduleUrl = (name: string) => JSON.stringify(new URL(`../${name}.js`, import.meta.url).href);
    for (const scenario of ['lost-response', 'balance-error', 'max']) {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hodl-interactive-'));
        try {
            const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
                import assert from 'node:assert/strict';
                import fs from 'node:fs';
                import os from 'node:os';
                import path from 'node:path';
                import inquirer from 'inquirer';
                import Persist from ${moduleUrl('persist')};
                import BitcoinNetwork from ${moduleUrl('network/lib/BitcoinNetwork')};
                import btc from ${moduleUrl('network/btc')};
                import { NetworkRegistry } from ${moduleUrl('network-registry')};
                import { runCli } from ${moduleUrl('index')};
                assert.equal(os.homedir(), ${JSON.stringify(home)});
                globalThis.fetch = async () => { throw new Error('Network access forbidden in test'); };
                const scenario = ${JSON.stringify(scenario)};
                const root = path.join(os.homedir(), '.HODL');
                fs.mkdirSync(root);
                const db = new Persist({ path: root, encryptionKey: 'fixture-password' });
                await db.connect();
                await db.set('account', 'BitcoinNetwork', { address: ${JSON.stringify(FROM)}, privateKey: 'fixture-only-key' });
                await db.dispose();
                NetworkRegistry.prototype.list = () => [btc];
                let signs = 0, broadcasts = 0, status = 'not_found';
                BitcoinNetwork.prototype.prepareTransfer = async (from, to, amount, asset) => {
                    signs++;
                    if (amount === 'max') amount = '0.001';
                    return {
                        from: from.address, to, amount, asset, amountBaseUnits: '100000',
                        fee: { asset: 'BTC', amount: '0.00001', baseUnits: '1000', decimals: 8, estimated: true },
                        rawTransaction: 'signed-ui-fixture', transactionHash: 'a'.repeat(64)
                    };
                };
                BitcoinNetwork.prototype.sendSignedTransaction = async () => {
                    broadcasts++;
                    if (scenario === 'lost-response') throw new Error('Response lost');
                    return { transactionHash: 'a'.repeat(64) };
                };
                BitcoinNetwork.prototype.getTransactionStatus = async transactionHash => ({ state: status, transactionHash });
                BitcoinNetwork.prototype.getAssetBalance = async () => {
                    if (scenario === 'balance-error') throw new Error('Balance RPC unavailable');
                    return { asset: 'BTC', amount: '1', baseUnits: '100000000', decimals: 8 };
                };
                const actions = ['transferFunds', ...(scenario === 'lost-response' ? ['transferFunds', 'transferFunds'] : []), 'showTransactions', 'exit'];
                let resumes = 0;
                inquirer.prompt = async question => {
                    const name = question.name;
                    if (name === 'action') { assert.ok(actions.length); return { action: actions.shift() }; }
                    if (name === 'requestId') {
                        resumes++;
                        status = resumes === 1 ? 'submitted' : 'confirmed';
                        return { requestId: question.choices[0].value };
                    }
                    const answers = { key: 'fixture-password', recipient: ${JSON.stringify(FROM)}, amount: scenario === 'max' ? ' MAX ' : '0.001', confirmTransaction: true, name: '' };
                    assert.ok(name in answers, 'Unexpected prompt: ' + name);
                    return { [name]: answers[name] };
                };
                await runCli([]);
                assert.equal(signs, scenario === 'max' ? 2 : 1);
                assert.equal(broadcasts, 1);
                assert.equal(actions.length, 0);
                const read = new Persist({ path: root, encryptionKey: 'fixture-password' });
                await read.connect();
                const requests = await read.values('sendRequest');
                assert.equal(requests.length, 1);
                assert.equal(requests[0].state, scenario === 'lost-response' ? 'confirmed' : 'submitted');
                if (scenario === 'lost-response') assert.equal((await read.values('transactions', ${JSON.stringify(FROM)}, 'BTC')).length, 1);
                await read.dispose();
            `], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 30_000 });
            const output = child.stdout + child.stderr;
            assert.equal(child.status, 0, output);
            assert.match(output, /Transaction submitted; awaiting confirmation/);
            assert.doesNotMatch(output, /Transaction failed/);
            if (scenario === 'balance-error') {
                assert.match(output, /Transfer recorded; could not update/);
                assert.doesNotMatch(output, /Transaction confirmed!/);
                assert.match(output, /submitted/);
            } else if (scenario === 'max') {
                assert.match(output, /Maximum: 0.001 BTC/);
                assert.doesNotMatch(output, /NaN/);
            } else {
                assert.match(output, /Transaction confirmed!/);
                assert.match(output, /Saved transfer:/);
            }
        } finally { fs.rmSync(home, { recursive: true, force: true }); }
    }
});

test('max retries and menu recovery reuse the resolved amount without signing again', async () => {
    const f = await fixture();
    try {
        const original = f.service();
        const network = (original as any).network;
        const prepare = network.prepareTransfer.bind(network);
        network.prepareTransfer = (from: WalletAccount, to: string, amount: string, asset: string) =>
            prepare(from, to, amount === 'max' ? '0.001' : amount, asset);
        const sent = await original.send({ ...request, amount: 'MAX' });
        assert.equal(sent.amount, '0.001');
        f.state.status = 'confirmed';
        await f.reopen();
        assert.equal((await f.service().send({ ...request, amount: 'max' })).transactionHash, sent.transactionHash);
        assert.equal((await f.service().send(request)).transactionHash, sent.transactionHash);
        assert.equal(f.state.signs, 1);
        assert.equal(f.state.broadcasts.length, 1);
    } finally { await f.close(); }
});

test('EVM max reserves gas for native funds and sends the full token balance', async () => {
    const { default: Web3Network } = await import('../network/lib/Web3Network.js');
    const { default: bsc } = await import('../network/bsc.js');
    const network = new Web3Network(bsc);
    let native = 1000000n;
    let signed: any;
    const web3 = (network as any).web3;
    web3.eth.getChainId = async () => 56n;
    web3.eth.getTransactionCount = async () => 0n;
    web3.eth.estimateGas = async () => 21000n;
    web3.eth.accounts.signTransaction = async (tx: any) => {
        signed = tx;
        return { rawTransaction: '0x01', transactionHash: '0xabc' };
    };
    network.getGasPrice = async () => 2n;
    network.getAssetBalance = async (_address, asset) => ({
        asset, decimals: 18, baseUnits: String(asset === 'BNB' ? native : 1234567890123456789n), amount: 'unused'
    });
    const from = { address: '0x1111111111111111111111111111111111111111', privateKey: 'fixture' };
    const nativeResult = await network.prepareTransfer(from, from.address, 'max', 'BNB');
    assert.equal(nativeResult.amountBaseUnits, '958000');
    assert.equal(BigInt(signed.value) + BigInt(signed.gas) * BigInt(signed.gasPrice), native);
    const tokenResult = await network.prepareTransfer(from, from.address, 'max', 'USDT');
    assert.equal(tokenResult.amountBaseUnits, '1234567890123456789');
    assert.ok(signed.data.endsWith(1234567890123456789n.toString(16).padStart(64, '0')));
    native = 42000n;
    await assert.rejects(network.prepareTransfer(from, from.address, 'max', 'BNB'), /Insufficient/);
    native = 0n;
    await assert.rejects(network.prepareTransfer(from, from.address, 'max', 'USDT'), /Insufficient/);
});

test('Bitcoin max spends all inputs with one output and subtracts the fee', async () => {
    const bitcoin = await import('bitcoinjs-lib');
    const network = new BitcoinNetwork(btc);
    const from = await network.createAccount();
    const previous = [100000, 200000].map((value, index) => {
        const tx = new bitcoin.Transaction();
        tx.addInput(Buffer.alloc(32, index + 1), 0);
        tx.addOutput(bitcoin.address.toOutputScript(from.address), value);
        return tx;
    });
    network.getUTXOs = async () => previous.map(tx => ({ txid: tx.getId(), vout: 0, value: tx.outs[0].value }));
    network.getTransaction = async id => previous.find(tx => tx.getId() === id)!.toHex();
    const result = await network.prepareTransfer(from, FROM, 'max', 'BTC', { feeRate: 2 });
    const tx = bitcoin.Transaction.fromHex(result.rawTransaction);
    assert.equal(tx.ins.length, 2);
    assert.equal(tx.outs.length, 1);
    assert.equal(tx.outs[0].value, 300000 - network.estimateTxSize(2, 1) * 2);
    assert.equal(BigInt(result.amountBaseUnits) + BigInt(result.fee.baseUnits), 300000n);
    network.getUTXOs = async () => [];
    await assert.rejects(network.prepareTransfer(from, FROM, 'max', 'BTC'), /Insufficient/);
});

test('read-only tracking reconciles every pending state without another signature or broadcast', async () => {
    const f = await fixture();
    try {
        await f.service().send(request);
        for (const state of ['prepared', 'broadcasting', 'submitted', 'broadcast_unknown']) {
            const stored = await f.db.get('sendRequest', request.requestId);
            await f.db.set('sendRequest', request.requestId, { ...stored, state });
            await f.db.flush();
            f.state.status = 'not_found';
            const result = await f.service().track(request.requestId);
            assert.equal(result.status, state === 'prepared' ? 'prepared' : 'broadcast_unknown');
            assert.equal('rawTransaction' in result, false);
            f.state.status = 'confirmed';
            assert.equal((await f.service().track(request.requestId)).status, 'confirmed');
        }
        assert.equal(f.state.signs, 1);
        assert.equal(f.state.broadcasts.length, 1);
        await assert.rejects(f.service().track('missing'), { code: 'INVALID_ARGUMENT' });
        await assert.rejects(f.service().track('__proto__'), { code: 'INVALID_ARGUMENT' });
    } finally { await f.close(); }
});

test('read-only tracking retains the saved state when the provider cannot be reached', async () => {
    const f = await fixture();
    try {
        await f.service().send(request);
        f.state.failStatus = true;
        await assert.rejects(f.service().track(request.requestId), { code: 'NETWORK_ERROR' });
        assert.equal((await f.service().list())[0].status, 'submitted');
        assert.equal(f.state.broadcasts.length, 1);
    } finally { await f.close(); }
});

test('EVM estimation uses no signing key and a higher fee stops signing at the confirmed limit', async () => {
    const { default: Web3Network } = await import('../network/lib/Web3Network.js');
    const { default: bsc } = await import('../network/bsc.js');
    const network = new Web3Network(bsc);
    const address = '0x1111111111111111111111111111111111111111';
    let gasPrice = 2n;
    let signs = 0;
    const web3 = (network as any).web3;
    web3.eth.getChainId = async () => 56n;
    web3.eth.getTransactionCount = async () => 0n;
    web3.eth.estimateGas = async () => 21000n;
    web3.eth.accounts.signTransaction = async () => { signs++; return { rawTransaction: '0x01', transactionHash: '0xabc' }; };
    network.getGasPrice = async () => gasPrice;
    network.getAssetBalance = async (_address, asset) => ({ asset, decimals: 18, baseUnits: '1000000000000000000', amount: '1' });
    for (const asset of ['BNB', 'USDT']) {
        const quote = await network.estimateTransfer(address, address, '0.1', asset);
        assert.equal('rawTransaction' in quote, false);
        const previousSigns = signs;
        gasPrice *= 2n;
        const account = { address, get privateKey(): string { throw new Error('Signing key was accessed'); } };
        await assert.rejects(network.prepareTransfer(account, address, '0.1', asset, { maxFeeBaseUnits: quote.fee.baseUnits }), /confirmed limit/);
        assert.equal(signs, previousSigns);
        gasPrice /= 2n;
        const prepared = await network.prepareTransfer({ address, privateKey: 'fixture' }, address, '0.1', asset, { maxFeeBaseUnits: quote.fee.baseUnits });
        const { rawTransaction, transactionHash, ...actual } = prepared;
        assert.deepEqual(actual, quote);
        assert.equal(signs, previousSigns + 1);
    }
});

test('Bitcoin estimation matches the signed transfer and enforces the fee cap before reading the key', async () => {
    const bitcoin = await import('bitcoinjs-lib');
    const network = new BitcoinNetwork(btc);
    const from = await network.createAccount();
    const previous = new bitcoin.Transaction();
    previous.addInput(Buffer.alloc(32, 1), 0);
    previous.addOutput(bitcoin.address.toOutputScript(from.address), 100000);
    network.getUTXOs = async () => [{ txid: previous.getId(), vout: 0, value: 100000 }];
    network.getTransaction = async () => previous.toHex();
    const quote = await network.estimateTransfer(from.address, FROM, '0.0001', 'BTC', { feeRate: 2 });
    assert.equal('rawTransaction' in quote, false);
    const guarded = { address: from.address, get privateKey(): string { throw new Error('Signing key was accessed'); } };
    await assert.rejects(network.prepareTransfer(guarded, FROM, '0.0001', 'BTC', { feeRate: 3, maxFeeBaseUnits: quote.fee.baseUnits }), /confirmed limit/);
    const { rawTransaction, transactionHash, ...actual } = await network.prepareTransfer(from, FROM, '0.0001', 'BTC', { feeRate: 2, maxFeeBaseUnits: quote.fee.baseUnits });
    assert.deepEqual(actual, quote);
    assert.equal(bitcoin.Transaction.fromHex(rawTransaction).getId(), transactionHash);
});

test('EVM status maps Web3 missing receipts and transactions without swallowing RPC failures', async () => {
    const { TransactionNotFound } = await import('web3');
    const { default: Web3Network } = await import('../network/lib/Web3Network.js');
    const { default: bsc } = await import('../network/bsc.js');
    const network = new Web3Network(bsc);
    const eth = (network as any).web3.eth;
    const hash = '0x' + '1'.repeat(64);
    eth.getTransactionReceipt = async () => { throw new TransactionNotFound(); };
    eth.getTransaction = async () => { throw new TransactionNotFound(); };
    assert.equal((await network.getTransactionStatus(hash)).state, 'not_found');
    eth.getTransaction = async () => ({ hash });
    assert.equal((await network.getTransactionStatus(hash)).state, 'submitted');
    const failure = new Error('RPC unavailable');
    eth.getTransactionReceipt = async () => { throw failure; };
    await assert.rejects(network.getTransactionStatus(hash), error => error === failure);
});
