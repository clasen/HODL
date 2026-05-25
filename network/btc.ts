import BitcoinNetwork from './lib/BitcoinNetwork.js';
import type { NetworkPlugin } from './types.js';

const bitcoin = {
    NetworkClass: BitcoinNetwork,
    name: '[BTC] Bitcoin',
    url: 'https://blockstream.info/api',
    nativeToken: 'BTC',
    explorer: 'https://btcscan.org/tx/',
    tokens: {}
} satisfies NetworkPlugin;

export default bitcoin;
