import * as bitcoin from 'bitcoinjs-lib';
import { swapConfig as config } from './config.js';
import { evmAddress, textField } from './http.js';
import type { SwapRouteId } from './types.js';

const usdt = {
    network: config.source, asset: config.asset, decimals: config.decimals,
    price: 'usdt' as const, confirmations: config.bscConfirmations,
    pendingState: 'output_pending' as const, confirmingState: 'output_confirming' as const,
    label: 'USDT (BSC)', chainflip: { chain: 'Bsc', asset: 'USDT', id: config.chainflip.sourceAsset },
    thorchain: { chain: 'BSC', asset: config.thorchain.asset, scale: 10n ** BigInt(config.decimals - 8) }
};
const btc = {
    network: config.destination, asset: 'BTC', decimals: 8,
    price: 'btc' as const, confirmations: config.bitcoinConfirmations,
    pendingState: 'btc_pending' as const, confirmingState: 'btc_confirming' as const,
    label: 'BTC (Bitcoin)', chainflip: { chain: 'Bitcoin', asset: 'BTC', id: 'Btc' },
    thorchain: { chain: 'BTC', asset: 'BTC.BTC', scale: 1n }
};

export const swapRoutes = {
    'bsc-btc': { id: 'bsc-btc', source: usdt, destination: btc },
    'btc-bsc': { id: 'btc-bsc', source: btc, destination: usdt }
} as const;
export type SwapRoute = typeof swapRoutes[SwapRouteId];
export type SwapAsset = SwapRoute['source'];

export function swapRoute(id: string): SwapRoute {
    if (id !== 'bsc-btc' && id !== 'btc-bsc') throw new Error('Unsupported swap route.');
    return swapRoutes[id];
}

export function routeForNetwork(network: string): SwapRoute | undefined {
    return Object.values(swapRoutes).find(route => route.source.network.id === network);
}

export function assetAddress(asset: SwapAsset, value: unknown): string {
    if (asset.network.family === 'evm') return evmAddress(value);
    const address = textField(value);
    bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin);
    return address;
}

export function sameAssetAddress(asset: SwapAsset, left: unknown, right: string): boolean {
    try {
        const a = assetAddress(asset, left);
        const b = assetAddress(asset, right);
        return asset.network.family === 'evm' ? a.toLowerCase() === b.toLowerCase() :
            bitcoin.address.toOutputScript(a).equals(bitcoin.address.toOutputScript(b));
    } catch { return false; }
}
