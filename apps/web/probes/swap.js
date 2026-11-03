import { SwapService, swapConfig } from 'hodl-wallet/browser/index.js';
import { NearIntentsSwapProvider } from 'hodl-wallet/dist/swap/providers.js';
import { TestStore, check } from './store.js';

/** Answers NEAR Intents as 1Click does, echoing the request it was sent. */
async function nearIntents(input, init) {
    const url = new URL(input);
    const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v0/tokens') return reply([
        { assetId: swapConfig.nearIntents.sourceAsset, blockchain: 'bsc', decimals: 18, contractAddress: swapConfig.token },
        { assetId: 'nep141:btc.omft.near', blockchain: 'btc', decimals: 8 }
    ]);
    if (url.pathname !== '/v0/quote') throw new Error(`Unexpected request: ${url}`);
    const request = JSON.parse(init.body);
    return reply({
        quote: { amountIn: request.amount, minAmountIn: request.amount, amountOut: '2577979', minAmountOut: '2565089', timeEstimate: 480, withdrawFee: '1900' },
        quoteRequest: { ...request, depositMode: 'SIMPLE', appFees: [{ recipient: 'fixture', fee: 20 }] }
    });
}

async function nearQuote() {
    const fetch = globalThis.fetch;
    globalThis.fetch = nearIntents;
    try {
        const { expectedBaseUnits, minimumBaseUnits, fees } = await new NearIntentsSwapProvider().quote({
            routeId: 'bsc-btc', amount: '2000', amountBaseUnits: '2000000000000000000000',
            from: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', to: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
        });
        return { expectedBaseUnits, minimumBaseUnits, fees };
    } finally { globalThis.fetch = fetch; }
}

export async function run() {
    const db = new TestStore();
    await db.set('account', 'BitcoinNetwork', { address: 'fixture-btc', privateKey: 'fixture-key' });
    const service = new SwapService(db);
    const destination = await service.destination();
    check(destination === 'fixture-btc', 'Swap did not use the store contract.');
    check((await db.get('account', 'BitcoinNetwork')).privateKey === 'fixture-key', 'Swap cleared stored secrets.');
    return { destination, operations: await service.list(), nearQuote: await nearQuote() };
}
