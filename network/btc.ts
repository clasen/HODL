import BitcoinNetwork from './lib/BitcoinNetwork.js';
import type { NetworkPlugin } from './types.js';

const bitcoin = {
    NetworkClass: BitcoinNetwork,
    id: 'btc',
    family: 'bitcoin',
    name: '[BTC] Bitcoin',
    url: 'https://blockstream.info/api',
    nativeToken: 'BTC',
    feeRate: 10,
    explorer: 'https://btcscan.org/tx/',
    tokens: {}
} satisfies NetworkPlugin;

export default bitcoin;
