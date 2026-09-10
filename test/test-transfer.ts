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
    for (const scenario of ['lost-response', 'balance-error']) {
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
                    const answers = { key: 'fixture-password', recipient: ${JSON.stringify(FROM)}, amount: '0.001', confirmTransaction: true, name: '' };
                    assert.ok(name in answers, 'Unexpected prompt: ' + name);
                    return { [name]: answers[name] };
                };
                await runCli([]);
                assert.equal(signs, 1);
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
            } else {
                assert.match(output, /Transaction confirmed!/);
                assert.match(output, /Saved transfer:/);
            }
        } finally { fs.rmSync(home, { recursive: true, force: true }); }
    }
});
