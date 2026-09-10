import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as bitcoin from 'bitcoinjs-lib';
import { Web3 } from 'web3';
import inquirer from 'inquirer';
import BitcoinNetwork from '../../network/lib/BitcoinNetwork.js';
import Persist from '../../persist.js';
import { WalletService } from '../../wallet-service.js';
import { runAgentCli } from '../../agent-cli.js';
import { bitcoinMemoOutputs } from '../bitcoin.js';
import { swapConfig as config } from '../config.js';
import { ChainflipSwapProvider, ThorchainSwapProvider } from '../providers.js';
import { swapRoutes } from '../routes.js';
import { SwapService } from '../service.js';
import { startSwapMenu } from '../ui.js';
import type { SwapOperation, SwapProviderId, SwapQuote } from '../types.js';

const destination = '0x1111111111111111111111111111111111111111';
const payoutHash = `0x${'a'.repeat(64)}`;
const refundHash = 'b'.repeat(64);
const blockHash = 'c'.repeat(64);
const tokenScale = 10n ** 18n;
const route = swapRoutes['btc-bsc'];
const prices = async () => ({ btc: '6000000000000', bnb: '60000000000', usdt: '100000000', updatedAt: Date.now() });

async function withReverse(providerId: SwapProviderId, work: (f: Awaited<ReturnType<typeof reverseFixture>>) => Promise<void>) {
    const f = await reverseFixture(providerId);
    const original = globalThis.fetch;
    globalThis.fetch = f.fetch;
    try { await work(f); }
    finally { globalThis.fetch = original; await f.db.dispose(); fs.rmSync(f.directory, { recursive: true, force: true }); }
}

async function reverseFixture(providerId: SwapProviderId) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hodl-reverse-test-'));
    const db = new Persist({ path: directory, encryptionKey: 'fixture-password' });
    await db.connect();
    const network = new BitcoinNetwork(config.destination);
    const account = await network.createAccount();
    const vault = (await network.createAccount()).address;
    await db.set('account', config.destination.NetworkClass.name, account);
    await db.set('account', config.source.NetworkClass.name, { address: destination, privateKey: 'unused-fixture-key' });
    const parent = new bitcoin.Transaction();
    parent.addInput(Buffer.alloc(32, 1), 0);
    parent.addOutput(bitcoin.address.toOutputScript(account.address), 2_000_000);
    const provider = providerId === 'thorchain' ? new ThorchainSwapProvider(route) : new ChainflipSwapProvider(route);
    const options = { routeId: route.id, providers: [provider], prices };
    const service = new SwapService(db, options);
    const f = {
        directory, db, network, account, vault, parent, provider, options, service,
        feeRate: 3, thorFeeRate: 3, thorDust: 1000, spent: false, broadcastFails: false, depositKnown: false, depositConfirmed: false,
        payout: false, payoutMined: false, payoutAmount: 600n * tokenScale, payoutConfirmations: 0,
        refund: false, refundAmount: 500_000, refundConfirmations: 0, settlementComplete: false,
        reasonUnavailable: false, reasonWrongTransaction: false,
        wrongToken: false, wrongRecipient: false, reorg: false, failStatus: false,
        mutation: '', broadcasts: [] as string[], channelRequests: [] as Record<string, any>[], quoteRequests: [] as URL[],
        quote: undefined as SwapQuote | undefined, operation: undefined as SwapOperation | undefined,
        async start(id = 'reverse') {
            const comparison = await service.quote('0.01');
            assert.equal(comparison.unavailable.length, 0, JSON.stringify(comparison.unavailable));
            f.quote = await db.get('swapQuote', comparison.quotes[0].quoteId) as SwapQuote;
            const result = await service.execute(f.quote.id, id);
            f.operation = await db.get('swapOperation', id) as SwapOperation;
            return result;
        },
        async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
            const url = String(input);
            let result: unknown;
            if (url === config.source.url) {
                const request = JSON.parse(String(init?.body));
                const values: Record<string, unknown> = {
                    eth_chainId: '0x38', eth_blockNumber: `0x${(99 + f.payoutConfirmations).toString(16)}`,
                    eth_getBlockByNumber: { hash: f.reorg ? 'd'.repeat(64) : blockHash },
                    eth_getTransactionReceipt: !f.payoutMined ? null : {
                        transactionHash: payoutHash, status: '0x1', blockNumber: '0x64', blockHash,
                        logs: [{ address: f.wrongToken ? destination : config.token,
                            topics: [new Web3().utils.keccak256('Transfer(address,address,uint256)'), '0x' + '0'.repeat(64),
                                '0x' + (f.wrongRecipient ? '2'.repeat(40) : destination.slice(2)).padStart(64, '0')],
                            data: `0x${f.payoutAmount.toString(16)}` }]
                    }
                };
                assert.ok(request.method in values, `Unexpected BSC RPC: ${request.method}`);
                result = { result: values[request.method] };
            } else if (url.endsWith('/fee-estimates')) result = { '1': f.feeRate };
            else if (url.endsWith('/utxo')) result = f.spent ? [] : [{ txid: parent.getId(), vout: 0, value: 2_000_000, status: { confirmed: true } }];
            else if (url.endsWith('/txs/mempool')) result = [];
            else if (url.endsWith(`/tx/${parent.getId()}/hex`)) return new Response(f.mutation === 'parent' ? '00' : parent.toHex());
            else if (url.endsWith('/blocks/tip/height')) return new Response(String(99 + (f.refund ? f.refundConfirmations : config.bitcoinConfirmations)));
            else if (url.includes('/block-height/')) return new Response(f.reorg ? 'd'.repeat(64) : blockHash);
            else if (url === `${config.destination.url}/tx` && init?.method === 'POST') {
                const raw = String(init.body);
                const transaction = bitcoin.Transaction.fromHex(raw);
                const entries = await db.entries('swapOperation') as Array<[string, SwapOperation]>;
                assert.ok(entries.some(([, operation]) => operation.steps.some(step => step.rawTransaction === raw && step.broadcastAttempted)), 'persist before broadcast');
                f.broadcasts.push(raw);
                f.depositKnown = true;
                if (f.broadcastFails) throw new Error('Lost broadcast response');
                return new Response(transaction.getId());
            } else if (url.includes(`${config.destination.url}/tx/`)) {
                const hash = url.split('/').at(-1)!;
                if (hash === refundHash) result = { txid: refundHash, vout: [{ scriptpubkey: bitcoin.address.toOutputScript(account.address).toString('hex'), value: f.refundAmount }], status: { confirmed: f.refundConfirmations > 0, block_height: 100, block_hash: blockHash } };
                else if (!f.depositKnown) return new Response('', { status: 404 });
                else result = { txid: hash, status: { confirmed: f.depositConfirmed, block_height: 90, block_hash: blockHash } };
            } else if (url.endsWith('/api/networkInfo')) result = { assets: [
                { asset: 'Btc', depositChannelCreationEnabled: true, depositChannelDepositsEnabled: true },
                { asset: 'BscUsdt', egressEnabled: true }
            ] };
            else if (url.includes('/v2/quote?')) {
                f.quoteRequests.push(new URL(url));
                result = [{ type: 'REGULAR', srcAsset: { chain: 'Bitcoin', asset: 'BTC' }, destAsset: { chain: 'Bsc', asset: 'USDT' },
                    depositAmount: '1000000', egressAmount: (600n * tokenScale).toString(), estimatedPrice: '60100',
                    includedFees: [{ chain: 'Bsc', asset: 'USDT', type: 'EGRESS', amount: tokenScale.toString() }], poolInfo: [], estimatedDurationSeconds: 600 }];
            } else if (url.endsWith('/api/openSwapDepositChannel')) {
                f.channelRequests.push(JSON.parse(String(init?.body)));
                result = { id: 'btc-channel', depositAddress: vault, estimatedExpiryTime: Date.now() + 1000000, srcChainExpiryBlock: '200', channelOpeningFee: '0', brokerCommissionBps: 0, maxBoostFeeBps: 0 };
            } else if (url.includes('/v2/swaps/')) {
                if (f.failStatus) throw new Error('Provider unavailable');
                result = { state: f.payout ? 'SENT' : f.depositConfirmed ? 'SWAPPING' : 'WAITING',
                    srcChain: 'Bitcoin', srcAsset: 'BTC', destChain: 'Bsc', destAsset: 'USDT', destAddress: destination,
                    depositChannel: { id: 'btc-channel', depositAddress: f.mutation === 'vault' ? account.address : vault, expectedDepositAmount: '1000000', isExpired: false },
                    fillOrKillParams: { refundAddress: f.mutation === 'refund' ? vault : account.address, minPrice: f.mutation === 'price' ? '1' : '59800', retryDurationBlocks: config.chainflip.refundRetryBlocks },
                    ...(f.depositConfirmed ? { deposit: { amount: '1000000', txRef: f.operation!.steps[0].hash } } : {}),
                    ...(f.payout ? { swapEgress: { txRef: payoutHash, amount: f.payoutAmount.toString() } } : {}),
                    ...(f.refund ? { refundEgress: { txRef: refundHash, amount: String(f.refundAmount) } } : {})
                };
            } else if (url.endsWith('/thorchain/inbound_addresses')) result = [
                { chain: 'BSC', address: destination, router: config.thorchain.router, halted: false, global_trading_paused: false, chain_trading_paused: false },
                { chain: 'BTC', address: f.mutation === 'vault' ? account.address : vault, dust_threshold: String(f.thorDust), gas_rate: String(f.thorFeeRate), halted: false, global_trading_paused: false, chain_trading_paused: false }
            ];
            else if (url.includes('/thorchain/quote/swap?')) {
                f.quoteRequests.push(new URL(url));
                result = { inbound_address: vault, expected_amount_out: '60000000000', expiry: Math.floor(Date.now() / 1000) + 1000,
                    recommended_min_amount_in: '10000', recommended_gas_rate: '3', gas_rate_units: 'satsperbyte',
                    fees: { asset: config.thorchain.asset, affiliate: '0', outbound: '100000000', liquidity: '10000' } };
            } else if (url.includes('/thorchain/tx/status/')) {
                if (f.failStatus) throw new Error('Provider unavailable');
                const outputs = [
                    ...(f.payout ? [{ chain: 'BSC', id: payoutHash, to_address: f.mutation === 'payout' ? destination.replace(/1/g, '2') : destination, coins: [{ asset: config.thorchain.asset, amount: (f.payoutAmount / 10n ** 10n).toString() }] }] : []),
                    ...(f.refund ? [{ chain: 'BTC', id: refundHash, to_address: account.address, memo: 'REFUND:fixture', coins: [{ asset: 'BTC.BTC', amount: String(f.refundAmount) }] }] : [])
                ];
                result = { tx: { id: f.operation!.steps[0].hash, chain: 'BTC', from_address: account.address, memo: f.operation!.plan!.memo, coins: [{ asset: 'BTC.BTC', amount: '1000000' }] },
                    out_txs: outputs, planned_out_txs: outputs,
                    stages: { swap_status: { pending: !f.settlementComplete }, outbound_signed: { completed: f.settlementComplete } } };
            } else if (url.startsWith(`${config.thorchain.midgardUrl}/v2/actions?`)) {
                if (f.reasonUnavailable) return new Response('', { status: 503 });
                result = { actions: [{ type: 'refund', in: [{ txID: f.reasonWrongTransaction ? refundHash : f.operation!.steps[0].hash }],
                    metadata: { refund: { reason: 'trading halted' } } }] };
            } else throw new Error(`Unexpected network request: ${url}`);
            return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
        }
    };
    return f;
}

for (const provider of ['chainflip', 'thorchain'] as const) {
    test(`${provider}: reverse deposit uses exact BTC outputs, fee budget and persisted transaction`, async () => {
        await withReverse(provider, async f => {
            const started = await f.start();
            assert.equal(started.state, 'deposit_pending', started.updateError || '');
            assert.equal(f.broadcasts.length, 1);
            assert.equal(started.quote.source.asset, 'BTC');
            assert.equal(started.quote.destination.asset, 'USDT');
            assert.equal(started.quote.funding.asset, 'BTC');
            const tx = bitcoin.Transaction.fromHex(f.broadcasts[0]);
            assert.equal(tx.outs[0].value, 1_000_000);
            assert.ok(tx.outs[0].script.equals(bitcoin.address.toOutputScript(f.vault)));
            assert.ok(tx.outs[1].script.equals(bitcoin.address.toOutputScript(f.account.address)));
            const debit = 2_000_000n - BigInt(tx.outs[1].value) - 1_000_000n;
            assert.equal(debit, BigInt(f.quote!.funding.budgetBaseUnits));
            assert.ok(tx.ins[0].witness.length > 0, 'locally signed');
            if (provider === 'thorchain') {
                assert.equal(f.quoteRequests[0].searchParams.get('extended'), 'true');
                const chunks = bitcoin.script.decompile(tx.outs[2].script)!;
                const head = (chunks[1] as Buffer).toString('ascii');
                assert.equal(head.at(-1), '^');
                const tail = Buffer.concat(tx.outs.slice(3).map(output => output.script.subarray(2))).toString('ascii').replace(/\0+$/, '');
                assert.equal(head.slice(0, -1) + tail, f.operation!.plan!.memo);
                assert.ok(tail.length > 0);
                assert.ok(f.operation!.plan!.memo!.includes(`/${f.account.address}:`));
                assert.ok(f.operation!.plan!.memo!.endsWith(':59700000000/1/0'));
            } else {
                assert.equal(tx.outs.length, 2);
                assert.equal(f.channelRequests[0].fillOrKillParams.refundAddress, f.account.address);
                assert.equal(f.channelRequests[0].srcAsset.chain, 'Bitcoin');
                assert.ok(BigInt(f.channelRequests[0].fillOrKillParams.minPriceX128) > (1n << 128n) * 59000n * 10n ** 10n);
            }
            const tracker = new SwapService(f.db, { prices });
            await tracker.status(started.requestId);
            await tracker.resume(started.requestId);
            assert.equal(f.broadcasts.length, 1, 'known transaction only tracked, even from default route');
        });
    });

    test(`${provider}: BSC payout is pending until receipt and canonical confirmations`, async () => {
        await withReverse(provider, async f => {
            await f.start(); f.depositConfirmed = true; f.payout = true; f.settlementComplete = true;
            assert.equal((await f.service.status('reverse')).state, 'output_pending');
            f.payoutMined = true; f.payoutConfirmations = 1;
            assert.equal((await f.service.status('reverse')).state, 'output_confirming');
            f.payoutConfirmations = config.bscConfirmations;
            const completed = await f.service.status('reverse');
            assert.equal(completed.state, 'completed', completed.updateError || '');
            assert.equal(completed.payout!.amount, '600');
            assert.ok(completed.payout!.explorer.startsWith(config.source.explorer));
            f.reorg = true;
            assert.notEqual((await f.service.status('reverse')).state, 'completed');
            assert.equal(f.broadcasts.length, 1);
        });
    });
}

test('reverse quote never signs or opens channels and rejects BTC precision and invalid BSC destinations', async () => {
    await withReverse('thorchain', async f => {
        const comparison = await f.service.quote('0.01');
        assert.equal(comparison.quotes[0].to, destination);
        assert.equal(comparison.quotes[0].refund.address, f.account.address);
        assert.equal(f.broadcasts.length, 0); assert.equal(f.channelRequests.length, 0);
        await assert.rejects(f.service.quote('0.000000001'), /decimal/);
        await assert.rejects(f.service.quote('0.01', f.account.address), /BSC/);
    });
});

for (const mutation of ['spent', 'fee', 'parent', 'vault', 'refund', 'price'] as const) {
    test(`reverse funding rejects changed ${mutation} without broadcasting`, async () => {
        await withReverse('chainflip', async f => {
            const comparison = await f.service.quote('0.01');
            if (mutation === 'spent') f.spent = true;
            else if (mutation === 'fee') f.feeRate = 50;
            else f.mutation = mutation;
            try {
                const result = await f.service.execute(comparison.quotes[0].quoteId, 'blocked');
                assert.equal(result.state, 'failed');
                assert.ok(result.updateError);
            } catch (error) { assert.match(String(error), /input|fee rate/); }
            assert.equal(f.broadcasts.length, 0);
        });
    });
}

test('reverse streaming verifies partial USDT and BTC refund independently, including restart', async () => {
    await withReverse('thorchain', async f => {
        await f.start(); f.depositConfirmed = true; f.payout = true; f.refund = true;
        f.payoutAmount = 300n * tokenScale; f.payoutMined = true; f.payoutConfirmations = config.bscConfirmations;
        f.refundConfirmations = config.bitcoinConfirmations;
        assert.equal((await f.service.status('reverse')).state, 'partial_pending');
        f.settlementComplete = true;
        const restartedDb = new Persist({ path: f.directory, encryptionKey: 'fixture-password' });
        await restartedDb.connect();
        try {
            const tracker = new SwapService(restartedDb, { prices });
            const result = await tracker.status('reverse');
            assert.equal(result.state, 'partial_completed', result.updateError || '');
            assert.equal(result.refund!.amount, '0.005');
            assert.equal(result.payout!.amount, '300');
            assert.equal(result.requiredConfirmations, config.bscConfirmations);
            assert.equal(result.requiredRefundConfirmations, config.bitcoinConfirmations);
        } finally { await restartedDb.dispose(); }
        assert.equal(f.broadcasts.length, 1);
    });
});

test('reverse refund and malformed payout cannot be mistaken for a successful swap', async () => {
    await withReverse('thorchain', async f => {
        await f.start(); f.depositConfirmed = true; f.settlementComplete = true;
        f.refund = true; f.refundAmount = 990_000; f.refundConfirmations = 1;
        assert.equal((await f.service.status('reverse')).state, 'refund_pending');
        f.refundConfirmations = config.bitcoinConfirmations;
        assert.equal((await f.service.status('reverse')).state, 'refunded');
        f.payout = true; f.payoutMined = true; f.payoutConfirmations = config.bscConfirmations;
        f.wrongToken = true;
        assert.equal((await f.service.status('reverse')).state, 'needs_attention');
        f.wrongToken = false; f.wrongRecipient = true;
        assert.equal((await f.service.status('reverse')).state, 'needs_attention');
        assert.equal(f.broadcasts.length, 1);
    });
});

test('reverse unknown broadcast survives restart and status never sends again', async () => {
    await withReverse('chainflip', async f => {
        f.broadcastFails = true;
        const started = await f.start();
        assert.equal(started.state, 'deposit_pending');
        const tracker = new SwapService(f.db, { prices });
        f.failStatus = true;
        await tracker.status('reverse');
        await tracker.execute(started.quote.quoteId, 'reverse');
        assert.equal(f.broadcasts.length, 1);
        f.failStatus = false;
        f.depositKnown = false;
        f.broadcastFails = false;
        const resumed = await tracker.resume('reverse');
        assert.equal(resumed.state, 'deposit_pending', resumed.updateError || '');
        assert.equal(f.broadcasts.length, 2);
        assert.equal(f.broadcasts[0], f.broadcasts[1], 'recovery reuses exactly the stored transaction');
    });
});

test('CLI selects reverse route with --network btc and status uses the stored route', async () => {
    await withReverse('chainflip', async f => {
        const wallet = new WalletService({ rootDir: f.directory, swapOptions: f.options });
        const output: string[] = [];
        const io = { isTTY: false, readStdin: async () => JSON.stringify({ password: 'fixture-password' }), writeStdout: (text: string) => output.push(text), writeStderr: () => undefined };
        const exit = await runAgentCli(['swap', 'quote', '--wallet', 'default', '--network', 'btc', '--amount', '0.01'], { service: wallet, io });
        assert.equal(exit, 0, output.join(''));
        const result = JSON.parse(output.join('')).data;
        assert.equal(result.quotes[0].routeId, 'btc-bsc');
        assert.equal(result.quotes[0].source.asset, 'BTC');
        assert.equal(f.broadcasts.length, 0);
        await assert.rejects(wallet.swap('default', 'fixture-password', { action: 'quote', amount: '1', network: 'eth' }), /bsc or btc/);
    });
});

test('reverse menu shows direction, source network fee and Bitcoin refund before cancellation', async () => {
    await withReverse('thorchain', async f => {
        const prompt = inquirer.prompt; const log = console.log; const lines: string[] = [];
        console.log = (...args) => lines.push(args.join(' '));
        inquirer.prompt = async (question: any) => {
            if (question.name === 'route') {
                assert.equal(question.choices[0].name, 'BTC (Bitcoin) → USDT (BSC)'); return { route: 'new' };
            }
            if (question.name === 'amount') return { amount: '0.01' };
            if (question.name === 'destination') return { destination };
            if (question.name === 'quoteId') return { quoteId: question.choices[0].value };
            assert.equal(question.name, 'confirmed'); return { confirmed: false };
        };
        try {
            await startSwapMenu(f.service);
            const summary = lines.join('\n');
            assert.ok(summary.includes('BTC (Bitcoin) → USDT (BSC)'));
            assert.ok(summary.includes('BTC extra on BTC'));
            assert.ok(summary.includes('15 USDT confirmations'));
            assert.ok(summary.includes('BTC (Bitcoin) → sender above, minus fees'));
            assert.equal(f.broadcasts.length, 0);
        } finally { inquirer.prompt = prompt; console.log = log; }
    });
});

test('Bitcoin memo encoding preserves short and long memos and rejects oversized transactions', () => {
    const short = bitcoinMemoOutputs('=:BSC.USDT:address:100/1/0');
    assert.equal(short.length, 1);
    assert.equal(short[0].value, 0);
    assert.throws(() => bitcoinMemoOutputs('x'.repeat(1000)), /output limit/);
    assert.throws(() => bitcoinMemoOutputs('invalid\n'), /memo/);
});

test('Bitcoin swaps and outgoing transfers share the pending-operation guard', async () => {
    await withReverse('chainflip', async f => {
        await f.db.set('sendRequest', 'pending-send', { network: 'btc', state: 'broadcast_unknown' });
        const quoteId = (await f.service.quote('0.01')).quotes[0].quoteId;
        await assert.rejects(f.service.execute(quoteId, 'blocked'), /existing BTC transfer/);
        await f.db.del('sendRequest', 'pending-send');
        await f.start();
        const wallet = new WalletService({ rootDir: f.directory });
        await assert.rejects(wallet.send({ wallet: 'default', password: 'fixture-password', network: 'btc', asset: 'BTC', amount: '0.001', to: f.vault, dryRun: false, requestId: 'blocked-send' }), /existing swap/);
        assert.equal(f.broadcasts.length, 1);
    });
});

test('THORChain rechecks Bitcoin fee and dust requirements before funding', async () => {
    for (const changed of ['fee', 'dust'] as const) {
        await withReverse('thorchain', async f => {
            const quoteId = (await f.service.quote('0.01')).quotes[0].quoteId;
            if (changed === 'fee') f.thorFeeRate = 50;
            else f.thorDust = 1_000_000;
            const result = await f.service.execute(quoteId, 'changed');
            assert.equal(result.state, 'failed');
            assert.match(result.updateError!, /funding requirements changed/);
            assert.equal(f.broadcasts.length, 0);
        });
    }
});

test('swap amount validates available BTC and precision before requesting a destination or quotes', async () => {
    await withReverse('thorchain', async f => {
        const prompt = inquirer.prompt;
        let checked = false;
        inquirer.prompt = async (question: any) => {
            if (question.name === 'route') return { route: 'new' };
            assert.equal(question.name, 'amount');
            assert.match(question.validate('0.1'), /Insufficient BTC/);
            assert.match(question.validate('0.000000001'), /8 decimal places/);
            assert.equal(question.validate('0.01'), true);
            assert.equal(question.validate(' MAX '), true);
            checked = true;
            return { amount: '' };
        };
        try {
            await startSwapMenu(f.service);
            assert.equal(checked, true);
            assert.equal(f.quoteRequests.length, 0);
            assert.equal(f.broadcasts.length, 0);
        } finally { inquirer.prompt = prompt; }
    });
});

test('BTC max requotes after reserving funding fees and required refund change', async () => {
    await withReverse('thorchain', async f => {
        const prompt = inquirer.prompt;
        let confirmed = false;
        inquirer.prompt = async (question: any) => {
            if (question.name === 'route') return { route: 'new' };
            if (question.name === 'amount') return { amount: 'max' };
            if (question.name === 'destination') return { destination };
            if (question.name === 'quoteId') {
                const quote = await f.db.get('swapQuote', question.choices[0].value) as SwapQuote;
                assert.equal(BigInt(quote.amountBaseUnits) + BigInt(quote.funding.budgetBaseUnits) + BigInt(config.bitcoin.changeDustSats), 2_000_000n);
                assert.ok(BigInt(quote.amountBaseUnits) < 2_000_000n);
                return { quoteId: quote.id };
            }
            assert.equal(question.name, 'confirmed');
            confirmed = true;
            return { confirmed: false };
        };
        try {
            await startSwapMenu(f.service);
            assert.equal(confirmed, true);
            assert.equal(f.quoteRequests.length, 2);
            assert.equal(f.broadcasts.length, 0);
        } finally { inquirer.prompt = prompt; }
    });
});

test('THORChain tracks early refund and its reason without confirming or sending funds again', async () => {
    await withReverse('thorchain', async f => {
        await f.start();
        f.refund = true; f.refundAmount = 990_000; f.refundConfirmations = 1; f.settlementComplete = true;
        const pending = await f.service.status('reverse');
        assert.equal(pending.state, 'refund_pending');
        assert.match(pending.message!, /trading halted/);
        assert.equal(pending.refund!.amount, '0.0099');
        const saved = await f.db.get('swapOperation', 'reverse') as SwapOperation;
        assert.equal(saved.steps[0].confirmed, false);
        f.refundConfirmations = config.bitcoinConfirmations;
        assert.equal((await f.service.status('reverse')).state, 'refund_pending');
        f.depositConfirmed = true;
        const tracker = new SwapService(f.db, f.options);
        const refunded = await tracker.status('reverse');
        assert.equal(refunded.state, 'refunded');
        assert.match(refunded.message!, /trading halted/);
        f.reasonUnavailable = true;
        const unavailable = await tracker.status('reverse');
        assert.equal(unavailable.state, 'refunded');
        assert.match(unavailable.message!, /reason is temporarily unavailable/);
        f.reasonUnavailable = false; f.reasonWrongTransaction = true;
        assert.doesNotMatch((await tracker.status('reverse')).message!, /trading halted/);
        assert.equal(f.broadcasts.length, 1);
    });
});
