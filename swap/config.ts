import bsc from '../network/bsc.js';
import btc from '../network/btc.js';

export const swapConfig = {
    source: bsc,
    destination: btc,
    asset: 'USDT',
    token: bsc.tokens.USDT.address,
    decimals: 18,
    slippageBps: 50,
    bitcoinConfirmations: 3,
    bscConfirmations: 15,
    httpTimeoutMs: 15_000,
    pollIntervalMs: 10_000,
    quoteLifetimeMs: 300_000,
    referenceMaxAgeMs: 300_000,
    clockSkewMs: 60_000,
    fundingMarginMs: 30_000,
    attentionAfterMs: 3_600_000,
    bitcoin: {
        changeDustSats: 546,
        memoDustSats: 294,
        maxOutputs: 10,
        feeTargetBlocks: 1
    },
    gas: {
        approval: 100_000,
        transfer: 120_000,
        deposit: 350_000
    },
    chainflip: {
        url: 'https://chainflip-swap.chainflip.io',
        blockSeconds: 6,
        refundRetryBlocks: 100,
        sourceAsset: 'BscUsdt'
    },
    thorchain: {
        midgardUrl: 'https://gateway.liquify.com/chain/thorchain_midgard',
        streamingInterval: 1,
        streamingQuantity: 0,
        url: 'https://gateway.liquify.com/chain/thorchain_api',
        router: '0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b',
        asset: `BSC.USDT-${bsc.tokens.USDT.address.toUpperCase()}`
    },
    pricesUrl: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,binancecoin,tether&vs_currencies=usd&include_last_updated_at=true&precision=8'
} as const;
