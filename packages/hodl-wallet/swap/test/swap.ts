import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { Web3 } from 'web3';
import Persist from '../../persist.js';
import { runAgentCli } from '../../agent-cli.js';
import { WalletService } from '../../wallet-service.js';
import { assertNoActiveSwap, SwapService } from '../service.js';
import { BscSwapChain } from '../chain.js';
import { ChainflipSwapProvider, ThorchainSwapProvider } from '../providers.js';
import { swapConfig as config } from '../config.js';
import { swapRoutes } from '../routes.js';
import inquirer from 'inquirer';
import ora from 'ora';
import { startSwapMenu, trackSwapsMenu } from '../ui.js';
import type { ChainReceipt, ProviderProgress, ProviderQuote, SwapInput, SwapOperation, SwapPlan, SwapPrices, SwapProvider, SwapProviderId, SwapQuote, SwapStep } from '../types.js';

const SOURCE = '0x1111111111111111111111111111111111111111';
const DESTINATION = 'bc1qyl7wjm2ldfezgnjk2c78adqlk7dvtm8sd7gn0q';
const VAULT = '0x2222222222222222222222222222222222222222';
const PAYOUT = 'a'.repeat(64);
const REFUND = `0x${'b'.repeat(64)}`;
const prices = async (): Promise<SwapPrices> => ({ btc: '6000000000000', bnb: '60000000000', usdt: '100000000', updatedAt: Date.now() });

class FakeChain extends BscSwapChain {
    broadcasts: string[] = [];
    signs = 0;
    approval = 0n;
    tokenBalance = 10n ** 24n;
    nativeBalance = 10n ** 20n;
    broadcastFails = false;
    receiptFails = false;
    paymentSats = 160_000n;
    confirmations = 0;
    refundAmount = 99n * 10n ** 18n;
    refundConfirmations = 0;
    states = new Map<string, ChainReceipt>();
    async checkSource() { return { balance: this.tokenBalance, nativeBalance: this.nativeBalance, gasPrice: 1_000_000_000n }; }
    async allowance() { return this.approval; }
    async assertNonceAvailable() {}
    async sign(_quote: SwapQuote, _plan: SwapPlan, kind: SwapStep['kind']): Promise<SwapStep> {
        this.signs++;
        return { kind, rawTransaction: `signed-fixture-${this.signs}`, hash: `0x${this.signs.toString(16).padStart(64, '0')}`, nonce: String(this.signs - 1), confirmed: false, broadcastAttempted: false };
    }
    async broadcast(step: SwapStep) {
        this.broadcasts.push(step.rawTransaction);
        if (this.broadcastFails) throw new Error('Response lost after submission');
        this.states.set(step.hash, { state: 'pending', confirmations: 0 });
    }
    async receipt(hash: string): Promise<ChainReceipt> {
        if (this.receiptFails) throw new Error('RPC unavailable');
        return this.states.get(hash) || { state: 'not_found', confirmations: 0 };
    }
    async blockNumber() { return 100n; }
    async payoutPayment() { return { amount: this.paymentSats, confirmations: this.confirmations }; }
    async refundPayment() { return { amount: this.refundAmount, confirmations: this.refundConfirmations }; }
    confirm(hash: string) { this.states.set(hash, { state: 'confirmed', confirmations: config.bscConfirmations }); }
}

class FakeProvider implements SwapProvider {
    streaming = false;
    expected = '160000';
    prepareCalls = 0;
    failed = false;
    prepareFails = false;
    progress: ProviderProgress = { state: 'swapping' };
    constructor(readonly id: SwapProviderId) {}
    async quote(_input: SwapInput): Promise<ProviderQuote> {
        if (this.failed) throw new Error('Route unavailable');
        return {
            provider: this.id, expectedBaseUnits: this.expected, minimumBaseUnits: (BigInt(this.expected) * 995n / 1000n).toString(),
            expiresAt: Date.now() + config.quoteLifetimeMs, estimatedSeconds: 60, fees: [],
            details: { gasPrice: '1000000000', streaming: this.streaming }
        };
    }
    async prepare(quote: SwapQuote): Promise<SwapPlan> {
        this.prepareCalls++;
        if (this.prepareFails) throw new Error('Channel creation response lost');
        return {
            depositAddress: VAULT, providerId: 'test-channel', expiresAt: quote.expiresAt,
            ...(this.id === 'thorchain' ? { router: config.thorchain.router, memo: 'fixture', expirySeconds: Math.floor(quote.expiresAt / 1000) } : { channelExpiryBlock: '10000' })
        };
    }
    async validate() {}
    async status() { if (this.failed) throw new Error('Provider unavailable'); return this.progress; }
}

async function fixture(providerId: SwapProviderId = 'chainflip') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hodl-swap-test-'));
    const db = new Persist({ path: directory, encryptionKey: 'fixture-password' });
    await db.connect();
    await db.set('account', config.source.NetworkClass.name, { address: SOURCE, privateKey: 'fixture-only-key' });
    await db.set('account', config.destination.NetworkClass.name, { address: DESTINATION, privateKey: 'fixture-only-btc-key' });
    const chain = new FakeChain();
    const provider = new FakeProvider(providerId);
    const options = { chain, providers: [provider], prices };
    const service = new SwapService(db, options);
    return {
        directory, db, chain, provider, service, options,
        async close() { await db.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
    };
}

test('quote defaults to configured Bitcoin account, validates external addresses, never signs', async () => {
    const f = await fixture();
    try {
        const result = await f.service.quote('100');
        assert.equal(result.quotes[0].to, DESTINATION);
        assert.equal(result.quotes[0].slippagePercent, 0.5);
        assert.equal(result.quotes[0].refund.address, SOURCE);
        assert.equal(f.chain.signs, 0);
        assert.equal(f.provider.prepareCalls, 0);
        assert.ok(Number(result.quotes[0].estimatedTotalCost.percent) > 2, 'expensive quotes are shown without an unrequested cost cap');
        await assert.rejects(f.service.quote('100', SOURCE), /Bitcoin mainnet/);
        await f.db.del('account', config.destination.NetworkClass.name);
        await assert.rejects(f.service.quote('100'), /provide a Bitcoin/);
        assert.equal((await f.service.quote('100', DESTINATION)).quotes.length, 1);
    } finally { await f.close(); }
});

test('comparison ranks net after gas and reports unavailable providers', async () => {
    const f = await fixture();
    try {
        const thor = new FakeProvider('thorchain');
        thor.expected = '160010';
        const service = new SwapService(f.db, { ...f.options, providers: [thor, f.provider] });
        const result = await service.quote('100');
        assert.equal(result.quotes[0].provider, 'chainflip');
        assert.equal(result.recommendedQuoteId, result.quotes[0].quoteId);
        thor.failed = true;
        const degraded = await service.quote('100');
        assert.equal(degraded.quotes.length, 1);
        assert.equal(degraded.unavailable[0].provider, 'thorchain');
    } finally { await f.close(); }
});

test('execution is persisted before broadcast and repeated request IDs reuse the exact signed transaction', async () => {
    const f = await fixture();
    try {
        const { quoteId } = (await f.service.quote('100')).quotes[0];
        const originalBroadcast = f.chain.broadcast.bind(f.chain);
        f.chain.broadcast = async step => {
            const stored = await f.db.get('swapOperation', 'once') as SwapOperation;
            assert.equal(stored.steps[0].hash, step.hash);
            assert.equal(stored.steps[0].broadcastAttempted, true);
            const onDisk = fs.readFileSync(path.join(f.directory, 'persist.json'), 'utf8');
            assert.ok(onDisk.startsWith('v2:'));
            assert.equal(onDisk.includes(step.rawTransaction), false);
            assert.equal(fs.statSync(path.join(f.directory, 'persist.json')).mode & 0o777, 0o600);
            await originalBroadcast(step);
        };
        f.chain.broadcastFails = true;
        const started = await f.service.execute(quoteId, 'once');
        assert.equal(started.state, 'deposit_pending');
        assert.match(started.updateError!, /uncertain/);
        const resumedService = new SwapService(f.db, f.options);
        await resumedService.execute(quoteId, 'once');
        assert.equal(f.chain.signs, 1);
        assert.equal(f.provider.prepareCalls, 1);
        assert.equal(f.chain.broadcasts[0], f.chain.broadcasts[1]);
        assert.equal(JSON.stringify(started).includes('signed-fixture'), false);
        await assert.rejects(resumedService.execute(quoteId, 'twice'), /existing swap/);
        await assert.rejects(resumedService.execute('another-quote', 'once'), /another swap quote/);
    } finally { await f.close(); }
});

test('a known pending BSC transaction is observed without redundant rebroadcasts', async () => {
    const f = await fixture();
    try {
        const quoteId = (await f.service.quote('100')).quotes[0].quoteId;
        await f.service.execute(quoteId, 'known-pending');
        await f.service.resume('known-pending');
        assert.equal(f.chain.broadcasts.length, 1);
        assert.equal(f.chain.signs, 1);
    } finally { await f.close(); }
});

test('status never broadcasts, disconnected providers preserve the last known stage, completion requires three confirmations', async () => {
    const f = await fixture();
    try {
        const { quoteId } = (await f.service.quote('100')).quotes[0];
        const started = await f.service.execute(quoteId, 'track');
        f.chain.confirm(started.transactions[0].hash);
        assert.equal((await f.service.status('track')).state, 'swapping');
        f.provider.failed = true;
        const interrupted = await f.service.status('track');
        assert.equal(interrupted.state, 'swapping');
        assert.match(interrupted.updateError!, /unavailable/);
        f.provider.failed = false;
        f.provider.progress = { state: 'payout_pending', payoutHash: PAYOUT, payoutBaseUnits: '160000' };
        assert.equal((await f.service.status('track')).state, 'btc_pending');
        f.chain.confirmations = 1;
        const one = await f.service.status('track');
        assert.equal(one.state, 'btc_confirming');
        const again = await f.service.status('track');
        assert.equal(again.history.length, one.history.length);
        f.chain.confirmations = 3;
        assert.equal((await f.service.status('track')).state, 'completed');
        f.chain.confirmations = 0;
        assert.equal((await f.service.status('track')).state, 'btc_pending', 'reorg observed on a subsequent check');
        assert.equal(f.chain.broadcasts.length, 1);
    } finally { await f.close(); }
});

test('refund completes only after exact USDT payment to source is verified on BSC', async () => {
    const f = await fixture();
    try {
        const quoteId = (await f.service.quote('100')).quotes[0].quoteId;
        const started = await f.service.execute(quoteId, 'refund');
        f.chain.confirm(started.transactions[0].hash);
        f.provider.progress = { state: 'refund_pending' };
        assert.equal((await f.service.status('refund')).state, 'refund_pending');
        f.provider.progress = { state: 'refund_pending', refundHash: REFUND, refundBaseUnits: f.chain.refundAmount.toString() };
        assert.equal((await f.service.status('refund')).state, 'refund_pending');
        f.chain.refundConfirmations = config.bscConfirmations;
        const refunded = await f.service.status('refund');
        assert.equal(refunded.state, 'refunded');
        assert.equal(refunded.refund?.amount, '99');
        await assert.rejects(f.service.execute(quoteId, 'refund-again'), /already used/);
    } finally { await f.close(); }
});

test('wrong payouts and partial results are never marked completed or refunded', async () => {
    const f = await fixture();
    try {
        const quoteId = (await f.service.quote('100')).quotes[0].quoteId;
        const started = await f.service.execute(quoteId, 'bad-payout');
        f.chain.confirm(started.transactions[0].hash);
        f.provider.progress = { state: 'payout_pending', payoutHash: PAYOUT, payoutBaseUnits: '160000' };
        f.chain.paymentSats = 1n;
        f.chain.confirmations = 3;
        assert.equal((await f.service.status('bad-payout')).state, 'needs_attention');
        f.chain.paymentSats = 160_000n;
        f.provider.progress = { state: 'refund_pending', payoutHash: PAYOUT, payoutBaseUnits: '160000', refundHash: REFUND, refundBaseUnits: f.chain.refundAmount.toString() };
        assert.equal((await f.service.status('bad-payout')).state, 'needs_attention');
    } finally { await f.close(); }
});

test('quote expiry and ambiguous channel creation never send funds', async () => {
    const f = await fixture();
    try {
        const quoteId = (await f.service.quote('100')).quotes[0].quoteId;
        const quote = await f.db.get('swapQuote', quoteId) as SwapQuote;
        await f.db.set('swapQuote', quoteId, { ...quote, expiresAt: Date.now() - 1 });
        await assert.rejects(f.service.execute(quoteId, 'expired'), /expired/);
        f.provider.prepareFails = true;
        const nextQuote = (await f.service.quote('100')).quotes[0];
        const failed = await f.service.execute(nextQuote.quoteId, 'channel-lost');
        assert.equal(failed.state, 'failed');
        await f.service.resume('channel-lost');
        assert.equal(f.provider.prepareCalls, 1);
        assert.equal(f.chain.signs, 0);
    } finally { await f.close(); }
});

test('THORChain approvals use one accepted budget and status does not fund the next step', async () => {
    const f = await fixture('thorchain');
    try {
        f.chain.approval = 1n;
        const quoteId = (await f.service.quote('100')).quotes[0].quoteId;
        f.chain.nativeBalance = BigInt(config.gas.approval * 2 + config.gas.deposit) * 1_000_000_000n;
        const reset = await f.service.execute(quoteId, 'approve');
        assert.equal(reset.transactions[0].kind, 'reset_approval');
        f.chain.confirm(reset.transactions[0].hash);
        f.chain.approval = 0n;
        f.chain.nativeBalance -= BigInt(config.gas.approval) * 1_000_000_000n;
        assert.equal((await f.service.status('approve')).state, 'preparing');
        assert.equal(f.chain.signs, 1);
        const approval = await f.service.resume('approve');
        assert.equal(approval.transactions[1].kind, 'approve');
        f.chain.confirm(approval.transactions[1].hash);
        f.chain.approval = 100n * 10n ** 18n;
        f.chain.nativeBalance -= BigInt(config.gas.approval) * 1_000_000_000n;
        const deposit = await f.service.resume('approve');
        assert.equal(deposit.transactions[2].kind, 'deposit');
        assert.equal(f.chain.signs, 3);
    } finally { await f.close(); }
});

test('active swaps block BSC sends and unresolved BSC sends block swaps', async () => {
    const f = await fixture();
    try {
        const quoteId = (await f.service.quote('100')).quotes[0].quoteId;
        await f.db.set('sendRequest', 'unresolved', { network: 'bsc', state: 'broadcast_unknown' });
        await assert.rejects(f.service.execute(quoteId, 'blocked'), /existing BSC/);
        await f.db.del('sendRequest', 'unresolved');
        await f.service.execute(quoteId, 'active');
        await assert.rejects(assertNoActiveSwap(f.db), /existing swap/);
    } finally { await f.close(); }
});

test('expired deposits are tracked without rebuilding or rebroadcasting them', async () => {
    const f = await fixture();
    try {
        const quoteId = (await f.service.quote('100')).quotes[0].quoteId;
        const started = await f.service.execute(quoteId, 'expired-pending');
        const stored = await f.db.get('swapOperation', 'expired-pending') as SwapOperation;
        stored.quote.expiresAt = Date.now() - 1;
        await f.db.set('swapOperation', stored.id, stored);
        assert.equal((await f.service.resume(stored.id)).state, 'deposit_pending');
        assert.equal(f.chain.broadcasts.length, 1);
        f.chain.confirm(started.transactions[0].hash);
        assert.equal((await f.service.resume(stored.id)).state, 'swapping');
        assert.equal(f.chain.signs, 1);
    } finally { await f.close(); }
});

test('CLI requires accepted quote plus --yes, supports external destinations and does not leak signing material', async () => {
    const f = await fixture();
    try {
        await f.db.dispose();
        const wallet = new WalletService({ rootDir: f.directory, swapOptions: f.options });
        async function cli(args: string[]) {
            let stdout = ''; let stderr = '';
            const code = await runAgentCli(args, {
                service: wallet,
                io: { readStdin: async () => '{"password":"fixture-password"}', writeStdout: value => { stdout += value; }, writeStderr: value => { stderr += value; } }
            });
            return { code, stdout, stderr, json: JSON.parse(stdout || stderr) };
        }
        const quote = await cli(['swap', 'quote', '--wallet', 'default', '--amount', '100', '--to', DESTINATION]);
        assert.equal(quote.code, 0);
        const quoteId = quote.json.data.quotes[0].quoteId;
        const args = ['swap', 'execute', '--wallet', 'default', '--quote-id', quoteId, '--request-id', 'cli-swap'];
        assert.equal((await cli(args)).code, 2);
        assert.equal(f.chain.signs, 0);
        const executed = await cli([...args, '--yes']);
        assert.equal(executed.code, 0);
        assert.equal(executed.json.data.state, 'deposit_pending');
        assert.equal(/signed-fixture|fixture-only-key|rawTransaction/.test(executed.stdout), false);
        assert.equal((await cli(['swap', 'list', '--wallet', 'default'])).json.data.swaps.length, 1);
        await cli(['swap', 'status', '--wallet', 'default', '--request-id', 'cli-swap']);
        assert.equal(f.chain.broadcasts.length, 1);
    } finally { await f.close(); }
});

async function mockedFetch<T>(handler: (url: string, init?: RequestInit) => unknown, work: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const value = handler(String(url), init);
        return value instanceof Response ? value : new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    };
    try { return await work(); } finally { globalThis.fetch = original; }
}

function thorInbound() {
    return ['BSC', 'BTC'].map(chain => ({ chain, address: VAULT, router: config.thorchain.router, halted: false, global_trading_paused: false, chain_trading_paused: false }));
}

test('THORChain adapter quotes automatic streaming and binds its exact memo through funding', async () => {
    const provider = new ThorchainSwapProvider();
    const input: SwapInput = { routeId: 'bsc-btc', from: SOURCE, to: DESTINATION, amount: '100', amountBaseUnits: (100n * 10n ** 18n).toString() };
    await mockedFetch(url => {
        if (url.endsWith('inbound_addresses')) return thorInbound();
        const params = new URL(url).searchParams;
        assert.equal(params.get('amount'), '10000000000');
        assert.equal(params.get('streaming_quantity'), '0');
        assert.equal(params.get('streaming_interval'), '1');
        assert.equal(params.get('refund_address'), SOURCE);
        return {
            inbound_address: VAULT, router: config.thorchain.router, expiry: Math.floor(Date.now() / 1000) + 600,
            recommended_min_amount_in: '1000000', expected_amount_out: '160000',
            fees: { asset: 'BTC.BTC', affiliate: '0', liquidity: '100', outbound: '200' },
            gas_rate_units: 'gwei', recommended_gas_rate: '1'
        };
    }, async () => {
        const offer = await provider.quote(input);
        assert.equal(offer.minimumBaseUnits, '159200');
        assert.equal(offer.details.memo, `=:BTC.BTC:${DESTINATION}/${SOURCE}:159200/1/0`);
        const quote = { ...input, ...offer } as SwapQuote;
        const plan = await provider.prepare(quote);
        assert.equal(plan.memo, offer.details.memo);
        await assert.rejects(provider.validate(quote, { ...plan, memo: plan.memo!.replace('/1/0', '/1/1') }), /parameters changed/);
        await assert.rejects(provider.quote({ ...input, amountBaseUnits: '100000000000000000001' }), /8 USDT/);
    });
    await mockedFetch(() => thorInbound().map(item => ({ ...item, halted: true })), async () => {
        await assert.rejects(provider.quote(input), /unavailable/);
    });
});

test('Chainflip unavailable BSC routes are excluded before quoting or opening channels', async () => {
    const provider = new ChainflipSwapProvider();
    let calls = 0;
    await mockedFetch(url => { calls++; assert.ok(url.endsWith('/api/networkInfo')); return { assets: [{ asset: 'Btc', egressEnabled: true }] }; }, async () => {
        await assert.rejects(provider.quote({ routeId: 'bsc-btc', from: SOURCE, to: DESTINATION, amount: '100', amountBaseUnits: (100n * 10n ** 18n).toString() }), /currently unavailable/);
    });
    assert.equal(calls, 1);
});

test('provider blocks explain missing assets, paused operations and unverified states in both directions', async () => {
    for (const route of Object.values(swapRoutes)) {
        const input: SwapInput = { routeId: route.id, from: SOURCE, to: DESTINATION, amount: '1', amountBaseUnits: '1000000000000000000' };
        for (const chain of ['BSC', 'BTC']) {
            for (const [field, reason] of [
                ['halted', 'chain halted'],
                ['global_trading_paused', 'global trading paused'],
                ['chain_trading_paused', 'chain trading paused']
            ]) {
                for (const value of [true, undefined, 'false']) {
                    await mockedFetch(url => {
                        assert.ok(url.endsWith('/inbound_addresses'));
                        return thorInbound().map(entry => entry.chain === chain ? { ...entry, [field]: value } : entry);
                    }, async () => {
                        await assert.rejects(new ThorchainSwapProvider(route).quote(input), {
                            message: `THORChain ${chain} trading is unavailable: ${reason}${value === true ? '' : ' status unverified'}.`
                        });
                    });
                }
            }
            await mockedFetch(url => {
                assert.ok(url.endsWith('/inbound_addresses'));
                return thorInbound().filter(entry => entry.chain !== chain);
            }, async () => {
                await assert.rejects(new ThorchainSwapProvider(route).quote(input), {
                    message: `THORChain ${chain} trading is unavailable: chain not listed by the provider API.`
                });
            });
        }
        for (const asset of [route.source, route.destination]) {
            await mockedFetch(url => {
                assert.ok(url.endsWith('/api/networkInfo'));
                return { assets: [route.source, route.destination].filter(item => item !== asset).map(item => ({ asset: item.chainflip.id })) };
            }, async () => {
                await assert.rejects(new ChainflipSwapProvider(route).quote(input), {
                    message: `Chainflip ${asset.label} is currently unavailable: asset not listed by the provider API.`
                });
            });
        }
        for (const [asset, field, action] of [
            [route.source, 'depositChannelCreationEnabled', 'deposit channel creation'],
            [route.source, 'depositChannelDepositsEnabled', 'deposits'],
            [route.destination, 'egressEnabled', 'payouts']
        ] as const) {
            for (const value of [false, undefined, 'true']) {
                await mockedFetch(url => {
                    assert.ok(url.endsWith('/api/networkInfo'));
                    return { assets: [route.source, route.destination].map(item => ({
                        asset: item.chainflip.id, depositChannelCreationEnabled: true, depositChannelDepositsEnabled: true, egressEnabled: true,
                        ...(item === asset ? { [field]: value } : {})
                    })) };
                }, async () => {
                    await assert.rejects(new ChainflipSwapProvider(route).quote(input), {
                        message: `Chainflip ${asset.label} is currently unavailable: ${action} ${value === false ? 'disabled by the provider' : 'status unverified'}.`
                    });
                });
            }
        }
    }
});

test('Bitcoin verification checks actual output script and canonical block, not provider status alone', async () => {
    const chain = new BscSwapChain();
    const bitcoin = await import('bitcoinjs-lib');
    const script = bitcoin.address.toOutputScript(DESTINATION).toString('hex');
    await mockedFetch(url => {
        if (url.endsWith('/blocks/tip/height')) return new Response('102');
        if (url.endsWith('/block-height/100')) return new Response('c'.repeat(64));
        return { txid: PAYOUT, vout: [{ scriptpubkey: script, value: 160000 }, { scriptpubkey: '00', value: 99999999 }], status: { confirmed: true, block_height: 100, block_hash: 'c'.repeat(64) } };
    }, async () => assert.deepEqual(await chain.payoutPayment(PAYOUT, DESTINATION), { amount: 160000n, confirmations: 3 }));
});

test('BSC refund verification counts only USDT Transfer logs to the original sender', async () => {
    const chain = new BscSwapChain();
    const topic = new Web3().utils.keccak256('Transfer(address,address,uint256)');
    await mockedFetch((_url, init) => {
        const request = JSON.parse(String(init?.body));
        const receipt = {
            transactionHash: REFUND, blockHash: '0xabc', blockNumber: '0x64', status: '0x1',
            logs: [
                { address: config.token, topics: [topic, '0x0', `0x${SOURCE.slice(2).padStart(64, '0')}`], data: '0x2a' },
                { address: VAULT, topics: [topic, '0x0', `0x${SOURCE.slice(2).padStart(64, '0')}`], data: '0xffff' }
            ]
        };
        const responses: Record<string, unknown> = { eth_chainId: '0x38', eth_getTransactionReceipt: receipt, eth_blockNumber: '0x72', eth_getBlockByNumber: { hash: '0xabc' } };
        return { result: responses[request.method] };
    }, async () => assert.deepEqual(await chain.refundPayment(REFUND, SOURCE), { amount: 42n, confirmations: 15 }));
});

test('a disk write failure before broadcasting leaves USDT untouched', async () => {
    const f = await fixture();
    try {
        const quoteId = (await f.service.quote('100')).quotes[0].quoteId;
        const originalSet = f.db.set.bind(f.db);
        let failOnce = true;
        f.db.set = async (...args: unknown[]) => {
            if (args[0] === 'swapOperation' && (args[2] as SwapOperation).steps.length && failOnce) {
                failOnce = false;
                throw new Error('Disk write failed');
            }
            return originalSet(...args);
        };
        const result = await f.service.execute(quoteId, 'disk-failure');
        assert.equal(result.state, 'failed');
        assert.equal(f.chain.broadcasts.length, 0);
        assert.match(result.updateError!, /Disk write/);
    } finally { await f.close(); }
});

test('a new persistence instance resumes the exact transaction after a restart', async () => {
    const f = await fixture();
    let reopened: Persist | undefined;
    try {
        const quoteId = (await f.service.quote('100')).quotes[0].quoteId;
        f.chain.broadcastFails = true;
        await f.service.execute(quoteId, 'restart');
        await f.db.dispose();
        reopened = new Persist({ path: f.directory, encryptionKey: 'fixture-password' });
        await reopened.connect();
        await new SwapService(reopened, f.options).resume('restart');
        assert.equal(f.chain.signs, 1);
        assert.equal(f.provider.prepareCalls, 1);
        assert.deepEqual(f.chain.broadcasts, ['signed-fixture-1', 'signed-fixture-1']);
    } finally { await reopened?.dispose(); await f.close(); }
});

test('a mined revert does not claim a provider refund or retry with a new transaction', async () => {
    const f = await fixture();
    try {
        const quoteId = (await f.service.quote('100')).quotes[0].quoteId;
        const result = await f.service.execute(quoteId, 'revert');
        f.chain.states.set(result.transactions[0].hash, { state: 'reverted', confirmations: 15 });
        const failed = await f.service.resume('revert');
        assert.equal(failed.state, 'failed');
        assert.equal(failed.refund, null);
        assert.equal(f.chain.signs, 1);
        assert.equal(f.chain.broadcasts.length, 1);
    } finally { await f.close(); }
});

test('CLI swap sessions share the profile lock with sends and other swap sessions', async () => {
    const f = await fixture();
    try {
        await f.db.dispose();
        const wallet = new WalletService({ rootDir: f.directory, swapOptions: f.options });
        const comparison = await wallet.swap('default', 'fixture-password', { action: 'quote', amount: '100' }) as Awaited<ReturnType<SwapService['quote']>>;
        await wallet.swap('default', 'fixture-password', { action: 'execute', quoteId: comparison.quotes[0].quoteId, requestId: 'shared-lock' });
        await assert.rejects(wallet.send({ wallet: 'default', password: 'fixture-password', network: 'bsc', asset: 'USDT', amount: '1', to: VAULT, dryRun: false, requestId: 'blocked-send' }), /existing swap/);
        let release!: () => void;
        let started!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const reached = new Promise<void>(resolve => { started = resolve; });
        const originalQuote = f.provider.quote.bind(f.provider);
        f.provider.quote = async input => { started(); await gate; return originalQuote(input); };
        const first = wallet.swap('default', 'fixture-password', { action: 'quote', amount: '100' });
        await reached;
        try { await assert.rejects(wallet.swap('default', 'fixture-password', { action: 'list' }), /locked/); }
        finally { release(); await first; }
    } finally { await f.close(); }
});

for (const provider of ['thorchain', 'chainflip'] as const) {
    test(`interactive ${provider} summary preserves quote terms and cancellation does not sign`, async () => {
        const f = await fixture(provider);
        f.provider.streaming = provider === 'thorchain';
        const prompt = inquirer.prompt;
        const log = console.log;
        const output: string[] = [];
        try {
            const quote = (await f.service.quote('100')).quotes[0];
            f.service.quote = async () => ({ quotes: [quote], recommendedQuoteId: quote.quoteId, unavailable: [] });
            console.log = (...values: unknown[]) => { output.push(values.join(' ')); };
            inquirer.prompt = async (question: { name: string; default?: boolean; choices?: Array<{ value: string }> }) => {
                switch (question.name) {
                    case 'route': return { route: 'usdt-btc' };
                    case 'amount': return { amount: '100' };
                    case 'destination': return { destination: DESTINATION };
                    case 'quoteId': return { quoteId: question.choices![0].value };
                    case 'confirmed':
                        assert.equal(question.default, false);
                        return { confirmed: false };
                    default: throw new Error('Unexpected interactive question');
                }
            };
            await startSwapMenu(f.service);
            assert.equal(f.provider.prepareCalls, 0);
            assert.equal(f.chain.signs, 0);
            const summary = output.join('\n');
            assert.ok(summary.includes(`${quote.source.amount} USDT → ≈ ${quote.destination.estimated} BTC`));
            assert.ok(summary.includes(quote.from));
            assert.ok(summary.includes(quote.to));
            assert.ok(summary.includes(`${quote.destination.minimum} BTC · full swap · ${quote.slippagePercent}% tolerance`));
            assert.ok(summary.includes(`≈ ${quote.estimatedTotalCost.percent}% (USD ${Number(quote.estimatedTotalCost.usd).toFixed(2)})`));
            assert.ok(summary.includes(`Up to ${quote.funding.budget} BNB extra on BSC`));
            assert.equal(summary.includes('Partial fill possible'), f.provider.streaming);
            assert.equal(summary.includes('minimum above applies only to a full swap'), f.provider.streaming);
            assert.ok(summary.includes('USDT (BSC) → sender above, minus fees'));
            assert.ok(summary.includes(`${config.bitcoinConfirmations} BTC confirmations to complete`));
            assert.ok(summary.includes('Provider fees already deducted from estimated BTC'));
            assert.ok(summary.includes('delayed BTC cannot auto-refund to USDT'));
        } finally { inquirer.prompt = prompt; console.log = log; await f.close(); }
    });
}

test('real BSC signer encodes exact allowance and protected router deposit without broadcasting', async () => {
    const chain = new BscSwapChain();
    const web3 = new Web3();
    const account = web3.eth.accounts.create();
    const f = await fixture('thorchain');
    try {
        const quoteId = (await f.service.quote('100')).quotes[0].quoteId;
        const quote = await f.db.get('swapQuote', quoteId) as SwapQuote;
        quote.from = account.address;
        const plan: SwapPlan = { depositAddress: VAULT, router: config.thorchain.router, memo: `=:BTC.BTC:${DESTINATION}/${account.address}:159200/1/0`, expiresAt: quote.expiresAt, expirySeconds: Math.floor(quote.expiresAt / 1000) };
        const requests: Array<Record<string, unknown>> = [];
        await mockedFetch((_url, init) => {
            const request = JSON.parse(String(init?.body));
            assert.notEqual(request.method, 'eth_sendRawTransaction');
            if (request.method === 'eth_estimateGas') requests.push(request.params[0]);
            const values: Record<string, unknown> = { eth_chainId: '0x38', eth_getTransactionCount: '0x0', eth_estimateGas: '0x10000' };
            return { result: values[request.method] };
        }, async () => {
            const approval = await chain.sign(quote, plan, 'approve', account);
            assert.equal(web3.eth.accounts.recoverTransaction(approval.rawTransaction), account.address);
            const approvalData = String(requests[0].data);
            assert.equal(approvalData.slice(0, 10), '0x095ea7b3');
            const decoded = web3.eth.abi.decodeParameters(['address', 'uint256'], `0x${approvalData.slice(10)}`);
            assert.equal(String(decoded[0]).toLowerCase(), config.thorchain.router);
            assert.equal(decoded[1], BigInt(quote.amountBaseUnits));
            const deposit = await chain.sign(quote, plan, 'deposit', account);
            assert.equal(web3.eth.accounts.recoverTransaction(deposit.rawTransaction), account.address);
            assert.equal(requests[1].to, config.thorchain.router);
            const decodedDeposit = web3.eth.abi.decodeParameters(['address', 'address', 'uint256', 'string', 'uint256'], `0x${String(requests[1].data).slice(10)}`);
            assert.equal(String(decodedDeposit[0]).toLowerCase(), VAULT);
            assert.equal(String(decodedDeposit[1]).toLowerCase(), config.token.toLowerCase());
            assert.equal(decodedDeposit[2], BigInt(quote.amountBaseUnits));
            assert.equal(decodedDeposit[3], plan.memo);
            assert.equal(decodedDeposit[4], BigInt(plan.expirySeconds!));
        });
        await mockedFetch(() => ({ result: '0x1' }), async () => {
            await assert.rejects(chain.sign(quote, plan, 'deposit', account), /chain ID mismatch/);
        });
    } finally { Persist.clearSensitiveData(account); await f.close(); }
});

test('Chainflip channel request binds refund, disables partial fills, and rejects changed destination', async () => {
    const provider = new ChainflipSwapProvider();
    const f = await fixture();
    let body: Record<string, unknown> | undefined;
    let changeDestination = false;
    const cfQuote = {
        type: 'REGULAR', srcAsset: { chain: 'Bsc', asset: 'USDT' }, destAsset: { chain: 'Bitcoin', asset: 'BTC' },
        depositAmount: (100n * 10n ** 18n).toString(), egressAmount: '160000', estimatedPrice: '0.00001602',
        includedFees: [{ chain: 'Bitcoin', asset: 'BTC', amount: '200', type: 'EGRESS' }],
        estimatedDurationSeconds: 120, poolInfo: [], lowLiquidityWarning: false
    };
    try {
        const input: SwapInput = { routeId: 'bsc-btc', from: SOURCE, to: DESTINATION, amount: '100', amountBaseUnits: cfQuote.depositAmount };
        await mockedFetch((url, init) => {
            if (url.endsWith('/api/networkInfo')) return { assets: [
                { asset: 'BscUsdt', depositChannelCreationEnabled: true, depositChannelDepositsEnabled: true },
                { asset: 'Btc', egressEnabled: true }
            ] };
            if (url.includes('/v2/quote')) return [cfQuote, { ...cfQuote, type: 'DCA', egressAmount: '170000', dcaParams: { numberOfChunks: 2 } }];
            if (url.endsWith('/api/openSwapDepositChannel')) {
                body = JSON.parse(String(init?.body));
                return { id: 'channel-1', depositAddress: VAULT, estimatedExpiryTime: Date.now() + 1000000, srcChainExpiryBlock: '10000', channelOpeningFee: '0', brokerCommissionBps: 0, maxBoostFeeBps: 0 };
            }
            return {
                state: 'WAITING', srcChain: 'Bsc', srcAsset: 'USDT', destChain: 'Bitcoin', destAsset: 'BTC', destAddress: changeDestination ? 'wrong' : DESTINATION,
                depositChannel: { id: 'channel-1', depositAddress: VAULT, expectedDepositAmount: cfQuote.depositAmount, isExpired: false },
                fillOrKillParams: { refundAddress: SOURCE, retryDurationBlocks: config.chainflip.refundRetryBlocks, minPrice: '0.000016' }
            };
        }, async () => {
            const offer = await provider.quote(input);
            assert.equal(offer.expectedBaseUnits, '160000', 'higher DCA output is excluded');
            const storedId = (await f.service.quote('100')).quotes[0].quoteId;
            const base = await f.db.get('swapQuote', storedId) as SwapQuote;
            const quote = { ...base, ...offer };
            const plan = await provider.prepare(quote);
            const protection = body!.fillOrKillParams as Record<string, unknown>;
            assert.equal(protection.refundAddress, SOURCE);
            assert.equal(body!.maxBoostFeeBps, 0);
            assert.equal(body!.takeCommission, false);
            assert.equal(body!.dcaParams, undefined);
            assert.ok(BigInt(String(protection.minPriceX128)) > 0n);
            await provider.validate(quote, plan);
            changeDestination = true;
            await assert.rejects(provider.validate(quote, plan), /parameters/);
        });
    } finally { await f.close(); }
});


test('destination autocomplete offers only own account and typed addresses, excluding saved contacts', async () => {
    const f = await fixture();
    const prompt = inquirer.prompt;
    try {
        await f.db.set('contact', config.destination.name, 'bc1-other-contact', { name: 'Savings' });
        await f.db.set('contact', config.destination.name, DESTINATION, { name: 'Duplicate own account' });
        await f.db.set('contact', config.source.name, SOURCE, { name: 'BSC contact' });
        inquirer.prompt = async (question: { name: string; type: string; source: (answers: object, input?: string) => Array<{ name: string; value: string }> }) => {
            if (question.name === 'route') return { route: 'usdt-btc' };
            if (question.name === 'amount') return { amount: '100' };
            assert.equal(question.name, 'destination');
            assert.equal(question.type, 'autocomplete');
            const choices = question.source({});
            assert.equal(choices[0].value, DESTINATION);
            assert.match(choices[0].name, /My account/);
            assert.equal(choices.filter(choice => choice.value === DESTINATION).length, 1);
            assert.deepEqual(choices.map(choice => choice.value), [DESTINATION, '']);
            assert.ok(!choices.some(choice => choice.value === SOURCE));
            assert.ok(!question.source({}, 'savings').some(choice => choice.value === 'bc1-other-contact'));
            assert.equal(question.source({}, 'bc1-external')[0].value, 'bc1-external');
            return { destination: '' };
        };
        await startSwapMenu(f.service);
        assert.equal(f.chain.signs, 0);
    } finally { inquirer.prompt = prompt; await f.close(); }
});

test('quote spinner runs during lookup and stops before prompts or errors', async () => {
    const f = await fixture();
    const prompt = inquirer.prompt;
    const log = console.log;
    const error = console.error;
    const prototype = Object.getPrototypeOf(ora());
    const start = prototype.start;
    const stop = prototype.stop;
    const quote = f.service.quote.bind(f.service);
    let spinning = false;
    let starts = 0;
    let stops = 0;
    let fail = false;
    let reported = '';
    try {
        console.log = () => {};
        console.error = (message: string) => { assert.equal(spinning, false); reported = message; };
        prototype.start = function () { spinning = true; starts++; return this; };
        prototype.stop = function () { spinning = false; stops++; return this; };
        f.service.quote = async (...args) => {
            assert.equal(spinning, true);
            if (fail) throw new Error('Quote unavailable');
            return quote(...args);
        };
        inquirer.prompt = async (question: { name: string }) => {
            assert.equal(spinning, false);
            if (question.name === 'route') return { route: 'usdt-btc' };
            if (question.name === 'amount') return { amount: '100' };
            if (question.name === 'destination') return { destination: DESTINATION };
            if (question.name === 'quoteId') return { quoteId: 'cancel' };
            throw new Error('Unexpected question');
        };
        await startSwapMenu(f.service);
        assert.equal(stops, starts);
        fail = true;
        await startSwapMenu(f.service);
        assert.equal(stops, starts);
        assert.equal(reported, 'Quote unavailable');
        assert.equal(f.chain.signs, 0);
    } finally {
        prototype.start = start; prototype.stop = stop;
        inquirer.prompt = prompt; console.log = log; console.error = error;
        await f.close();
    }
});


test('missing Bitcoin account is explained instead of silently hiding My account', async () => {
    const f = await fixture();
    const prompt = inquirer.prompt;
    const log = console.log;
    const output: string[] = [];
    try {
        await f.db.del('account', config.destination.NetworkClass.name);
        console.log = (...values: unknown[]) => { output.push(values.join(' ')); };
        inquirer.prompt = async (question: { name: string; source: (answers: object, input?: string) => Array<{ name: string; value: string; disabled?: string }> }) => {
            if (question.name === 'route') return { route: 'usdt-btc' };
            if (question.name === 'amount') return { amount: '100' };
            assert.equal(question.name, 'destination');
            const choices = question.source({});
            assert.equal(choices[0].name, 'My account');
            assert.equal(choices[0].disabled, 'BTC (Bitcoin) account not configured');
            const manual = question.source({}, DESTINATION);
            assert.equal(manual[0].value, DESTINATION);
            assert.equal(manual[0].disabled, undefined);
            return { destination: '' };
        };
        await startSwapMenu(f.service);
        assert.ok(output.some(line => line.includes('Create or import an account on that network')));
        assert.equal(f.chain.signs, 0);
    } finally { inquirer.prompt = prompt; console.log = log; await f.close(); }
});


for (const first of ['btc', 'refund']) {
    test(`streaming verifies both partial payments when ${first} arrives first, including restart and reorg`, async () => {
        const f = await fixture('thorchain');
        try {
            f.provider.streaming = true;
            f.chain.approval = 100n * 10n ** 18n;
            const quote = (await f.service.quote('100')).quotes[0];
            assert.equal(quote.execution, 'streaming');
            assert.equal(quote.refund.partialResultPossible, true);
            const operation = await f.service.execute(quote.quoteId, `partial-${first}`);
            f.chain.confirm(operation.transactions[0].hash);
            f.chain.paymentSats = 80000n;
            f.chain.refundAmount = 49n * 10n ** 18n;
            f.chain.confirmations = config.bitcoinConfirmations;
            f.chain.refundConfirmations = config.bscConfirmations;
            const payout = { payoutHash: PAYOUT, payoutBaseUnits: '80000' };
            const refund = { refundHash: REFUND, refundBaseUnits: f.chain.refundAmount.toString() };
            f.provider.progress = { state: 'payout_pending', settlementComplete: false, ...(first === 'btc' ? payout : refund) };
            const waiting = await f.service.status(operation.requestId);
            assert.equal(waiting.state, 'payout_pending');
            await assert.rejects(assertNoActiveSwap(f.db), /existing swap/);
            const resumed = new SwapService(f.db, f.options);
            f.provider.progress = { state: 'payout_pending', settlementComplete: true, ...payout, ...refund };
            f.chain.refundConfirmations = 14;
            assert.equal((await resumed.status(operation.requestId)).state, 'partial_pending');
            f.chain.refundConfirmations = config.bscConfirmations;
            f.chain.confirmations = 2;
            assert.equal((await resumed.status(operation.requestId)).state, 'partial_pending');
            f.chain.confirmations = config.bitcoinConfirmations;
            const completed = await resumed.status(operation.requestId);
            assert.equal(completed.state, 'partial_completed');
            assert.equal(completed.payout?.amount, '0.0008');
            assert.equal(completed.refund?.amount, '49');
            await assertNoActiveSwap(f.db);
            f.chain.refundConfirmations = 0;
            assert.equal((await resumed.status(operation.requestId)).state, 'partial_pending');
            assert.equal(f.chain.broadcasts.length, 1);
        } finally { await f.close(); }
    });
}

test('streaming rejects mismatched partial payments and a short full payout', async () => {
    const f = await fixture('thorchain');
    try {
        f.provider.streaming = true;
        f.chain.approval = 100n * 10n ** 18n;
        const quote = (await f.service.quote('100')).quotes[0];
        const operation = await f.service.execute(quote.quoteId, 'stream-invalid');
        f.chain.confirm(operation.transactions[0].hash);
        f.chain.paymentSats = 80000n;
        f.chain.confirmations = config.bitcoinConfirmations;
        f.provider.progress = { state: 'payout_pending', settlementComplete: true, payoutHash: PAYOUT, payoutBaseUnits: '80000' };
        assert.equal((await f.service.status(operation.requestId)).state, 'needs_attention');
        f.provider.progress.refundHash = REFUND;
        f.provider.progress.refundBaseUnits = '49000000000000000000';
        f.chain.refundConfirmations = config.bscConfirmations;
        assert.equal((await f.service.status(operation.requestId)).state, 'needs_attention');
        f.chain.refundAmount = 49n * 10n ** 18n;
        f.provider.progress.payoutBaseUnits = '80001';
        assert.equal((await f.service.status(operation.requestId)).state, 'needs_attention');
    } finally { await f.close(); }
});

test('THORChain reports stream progress and waits for every planned outbound', async () => {
    const f = await fixture('thorchain');
    const provider = new ThorchainSwapProvider();
    try {
        f.chain.approval = 100n * 10n ** 18n;
        const quote = (await f.service.quote('100')).quotes[0];
        const started = await f.service.execute(quote.quoteId, 'provider-progress');
        const operation = await f.db.get('swapOperation', started.requestId) as SwapOperation;
        const tx = { id: started.transactions[0].hash, chain: 'BSC', from_address: SOURCE, memo: operation.plan!.memo,
            coins: [{ asset: config.thorchain.asset, amount: '10000000000' }] };
        const btc = { id: PAYOUT, chain: 'BTC', to_address: DESTINATION, coins: [{ asset: 'BTC.BTC', amount: '80000' }] };
        const refund = { id: REFUND, chain: 'BSC', to_address: SOURCE, memo: 'REFUND:test', coins: [{ asset: config.thorchain.asset, amount: '4900000000' }] };
        const data = { tx, out_txs: [] as object[], planned_out_txs: [{}, {}],
            stages: { swap_status: { pending: true, streaming: { interval: 1, quantity: 20, count: 4 } }, outbound_signed: { completed: false } } };
        await mockedFetch(() => data, async () => {
            const streaming = await provider.status(operation);
            assert.equal(streaming.state, 'swapping');
            assert.match(streaming.message!, /4 \/ 20/);
            data.stages.swap_status.pending = false;
            data.stages.outbound_signed.completed = true;
            data.out_txs = [btc];
            assert.equal((await provider.status(operation)).settlementComplete, false);
            data.out_txs = [btc, refund];
            const partial = await provider.status(operation);
            assert.equal(partial.settlementComplete, true);
            assert.equal(partial.refundBaseUnits, '49000000000000000000');
            assert.equal(partial.payoutBaseUnits, '80000');
            data.out_txs = [btc, { ...refund, to_address: VAULT }];
            await assert.rejects(provider.status(operation), /Unexpected THORChain payout/);
        });
    } finally { await f.close(); }
});


for (const outcome of ['completed', 'refunded']) {
    test(`streaming ${outcome} requires protocol settlement and canonical confirmations`, async () => {
        const f = await fixture('thorchain');
        try {
            f.provider.streaming = true;
            f.chain.approval = 100n * 10n ** 18n;
            const quote = (await f.service.quote('100')).quotes[0];
            const operation = await f.service.execute(quote.quoteId, outcome);
            f.chain.confirm(operation.transactions[0].hash);
            f.provider.progress = { state: 'payout_pending', settlementComplete: false,
                ...(outcome === 'completed' ? { payoutHash: PAYOUT, payoutBaseUnits: '160000' } :
                    { refundHash: REFUND, refundBaseUnits: f.chain.refundAmount.toString() }) };
            f.chain.confirmations = config.bitcoinConfirmations;
            f.chain.refundConfirmations = config.bscConfirmations;
            assert.equal((await f.service.status(operation.requestId)).state, 'payout_pending');
            f.provider.progress.settlementComplete = true;
            f.chain.confirmations = 2;
            f.chain.refundConfirmations = 14;
            assert.equal((await f.service.status(operation.requestId)).state, outcome === 'completed' ? 'btc_confirming' : 'refund_pending');
            f.chain.confirmations = config.bitcoinConfirmations;
            f.chain.refundConfirmations = config.bscConfirmations;
            assert.equal((await f.service.status(operation.requestId)).state, outcome);
        } finally { await f.close(); }
    });
}


test('tracking spinners cover read-only updates, and stop on completion, failure or Enter', async () => {
    const f = await fixture();
    const prompt = inquirer.prompt;
    const log = console.log;
    const error = console.error;
    const createInterface = readline.createInterface;
    const prototype = Object.getPrototypeOf(ora());
    const start = prototype.start;
    const stop = prototype.stop;
    let spinning = false;
    let summaries = 0;
    try {
        const quote = (await f.service.quote('100')).quotes[0];
        const operation = await f.service.execute(quote.quoteId, 'spinner-tracking');
        prototype.start = function () { spinning = true; return this; };
        prototype.stop = function () { spinning = false; return this; };
        console.log = (message: string) => {
            assert.equal(spinning, false);
            if (message.startsWith('\nSwap ')) summaries++;
        };
        console.error = () => { assert.equal(spinning, false); };
        inquirer.prompt = async (question: { name: string }) => {
            assert.equal(spinning, false);
            assert.equal(question.name, 'requestId');
            return { requestId: operation.requestId };
        };
        f.service.list = async () => { assert.equal(spinning, true); return [operation]; };
        f.service.resume = async () => { throw new Error('Tracking must never resume a swap'); };
        for (const outcome of ['completed', 'error', 'cancel']) {
            summaries = 0;
            const input = new EventEmitter();
            Object.assign(input, { close: () => input.emit('close') });
            readline.createInterface = (() => input) as unknown as typeof createInterface;
            let reads = 0;
            f.service.status = async () => {
                assert.equal(spinning, true);
                reads++;
                if (reads === 1) return operation;
                if (outcome === 'error') throw new Error('Status unavailable');
                if (outcome === 'cancel') {
                    setImmediate(() => {
                        assert.equal(spinning, true, 'spinner remains active between polls');
                        input.emit('line');
                    });
                    return operation;
                }
                return { ...operation, state: 'completed' };
            };
            await trackSwapsMenu(f.service);
            assert.equal(spinning, false);
            assert.equal(reads, 2);
            assert.equal(summaries, outcome === 'completed' ? 1 : 0, 'only changed swap data produces another summary');
        }
    } finally {
        inquirer.prompt = prompt; console.log = log; console.error = error;
        readline.createInterface = createInterface;
        prototype.start = start; prototype.stop = stop;
        await f.close();
    }
});

test('submission spinner stops before displaying a preparation error', async () => {
    const f = await fixture();
    const prompt = inquirer.prompt;
    const log = console.log;
    const error = console.error;
    const prototype = Object.getPrototypeOf(ora());
    const start = prototype.start;
    const stop = prototype.stop;
    let spinning = false;
    let reported = '';
    try {
        prototype.start = function () { spinning = true; return this; };
        prototype.stop = function () { spinning = false; return this; };
        console.log = () => { assert.equal(spinning, false); };
        console.error = (message: string) => { assert.equal(spinning, false); reported = message; };
        inquirer.prompt = async (question: { name: string; choices?: Array<{ value: string }> }) => {
            assert.equal(spinning, false);
            switch (question.name) {
                case 'route': return { route: 'usdt-btc' };
                case 'amount': return { amount: '100' };
                case 'destination': return { destination: DESTINATION };
                case 'quoteId': return { quoteId: question.choices![0].value };
                case 'confirmed': return { confirmed: true };
                default: throw new Error('Unexpected question');
            }
        };
        f.service.execute = async () => {
            assert.equal(spinning, true);
            throw new Error('Preparation unavailable');
        };
        await startSwapMenu(f.service);
        assert.equal(reported, 'Preparation unavailable');
        assert.equal(spinning, false);
    } finally {
        inquirer.prompt = prompt; console.log = log; console.error = error;
        prototype.start = start; prototype.stop = stop;
        await f.close();
    }
});


test('tracking every pending stage is read-only, while finished swaps only show the result', async () => {
    const f = await fixture();
    const prompt = inquirer.prompt;
    const log = console.log;
    const createInterface = readline.createInterface;
    try {
        const quote = (await f.service.quote('100')).quotes[0];
        const operation = await f.service.execute(quote.quoteId, 'funded-tracking');
        console.log = () => {};
        inquirer.prompt = async (question: { name: string }) => {
            assert.equal(question.name, 'requestId', 'tracking only asks which swap to view');
            return { requestId: operation.requestId };
        };
        const input = new EventEmitter();
        Object.assign(input, { close: () => input.emit('close') });
        readline.createInterface = (() => input) as unknown as typeof createInterface;
        let resumes = 0;
        f.service.resume = async () => { resumes++; throw new Error('Must not submit another transaction'); };
        for (const state of ['preparing', 'approval_pending', 'deposit_pending', 'swapping', 'btc_pending', 'refund_pending', 'completed', 'partial_completed', 'refunded', 'failed'] as const) {
            const current = { ...operation, state,
                transactions: operation.transactions.map(transaction => ({ ...transaction, confirmed: true })) };
            f.service.list = async () => [current];
            let reads = 0;
            f.service.status = async () => {
                reads++;
                return reads === 1 ? current : { ...current, state: 'completed' };
            };
            await trackSwapsMenu(f.service);
            assert.equal(reads, ['completed', 'partial_completed', 'refunded', 'failed'].includes(state) ? 1 : 2);
        }
        assert.equal(resumes, 0);
        assert.equal(f.chain.broadcasts.length, 1);
    } finally {
        inquirer.prompt = prompt; console.log = log; readline.createInterface = createInterface;
        await f.close();
    }
});

test('existing quotes and operations without a route retain their BSC funding and Bitcoin payout', async () => {
    const f = await fixture();
    try {
        const quoteId = (await f.service.quote('100')).quotes[0].quoteId;
        const quote = await f.db.get('swapQuote', quoteId) as SwapQuote;
        const { routeId, funding, expectedBaseUnits, minimumBaseUnits, netOutputBaseUnits, ...fields } = quote;
        const legacy = { ...fields, expectedSats: expectedBaseUnits, minimumSats: minimumBaseUnits,
            gasPrice: funding.rate, gasUnits: funding.units, gasBudgetWei: funding.budgetBaseUnits,
            netAfterGasSats: netOutputBaseUnits };
        await f.db.set('swapQuote', quoteId, legacy);
        const started = await f.service.execute(quoteId, 'legacy');
        const operation = await f.db.get('swapOperation', 'legacy') as SwapOperation;
        await f.db.set('swapOperation', 'legacy', { ...operation, quote: legacy, payoutSats: '160000' });
        f.chain.confirm(started.transactions[0].hash);
        f.provider.progress = { state: 'payout_pending', payoutHash: PAYOUT, payoutBaseUnits: '160000' };
        f.chain.confirmations = config.bitcoinConfirmations;
        const result = await f.service.status('legacy');
        assert.equal(result.state, 'completed', result.updateError || '');
        assert.equal(result.quote.routeId, 'bsc-btc');
        assert.equal(result.payout!.amount, '0.0016');
        assert.equal(f.chain.broadcasts.length, 1);
    } finally { await f.close(); }
});

test('USDT max quotes the entire token balance and still requires BNB for fees', async () => {
    const f = await fixture();
    const prompt = inquirer.prompt;
    let quoted = false;
    let selected = false;
    f.chain.nativeBalance = 0n;
    f.provider.quote = async input => {
        quoted = true;
        assert.equal(BigInt(input.amountBaseUnits), f.chain.tokenBalance);
        return { provider: 'chainflip', expectedBaseUnits: '160000', minimumBaseUnits: '159200',
            expiresAt: Date.now() + config.quoteLifetimeMs, estimatedSeconds: 60, fees: [], details: {} };
    };
    inquirer.prompt = async (question: any) => {
        if (question.name === 'route') return { route: 'new' };
        if (question.name === 'amount') return { amount: 'max' };
        if (question.name === 'destination') return { destination: DESTINATION };
        selected = true;
        return { quoteId: 'cancel' };
    };
    try {
        await startSwapMenu(f.service);
        assert.equal(quoted, true);
        assert.equal(selected, false);
        assert.equal(f.chain.signs, 0);
    } finally { inquirer.prompt = prompt; await f.close(); }
});

test('tracking refreshes a stale deposit before showing the selector and refunded detail', async () => {
    const f = await fixture();
    const prompt = inquirer.prompt;
    const log = console.log;
    try {
        const quote = (await f.service.quote('100')).quotes[0];
        const operation = await f.service.execute(quote.quoteId, 'stale-tracking');
        f.service.list = async () => [{ ...operation, state: 'deposit_pending' }];
        let reads = 0;
        f.service.status = async () => {
            reads++;
            return { ...operation, state: 'refunded', message: 'THORChain refund: trading halted.' };
        };
        const output: string[] = [];
        console.log = (message: string) => { output.push(message); };
        inquirer.prompt = async (question: { choices: Array<{ name: string }> }) => {
            assert.equal(reads, 1);
            assert.match(question.choices[0].name, /Swap refunded/);
            assert.doesNotMatch(question.choices[0].name, /waiting for confirmation/);
            return { requestId: operation.requestId };
        };
        await trackSwapsMenu(f.service);
        assert.equal(reads, 1);
        assert.ok(output.every(line => !line.startsWith('\nSwap ')), 'selector already shows the swap heading');
        assert.ok(output.some(line => line.startsWith('deposit:')));
        assert.ok(output.some(line => line.includes('trading halted')));
        assert.equal(f.chain.broadcasts.length, 1);
    } finally {
        inquirer.prompt = prompt; console.log = log;
        await f.close();
    }
});
