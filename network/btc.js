import BitcoinNetwork from './lib/BitcoinNetwork.js';

export default {
    NetworkClass: BitcoinNetwork,
    name: '[BTC] Bitcoin',
    url: 'https://blockstream.info/api',
    nativeToken: 'BTC',
    explorer: 'https://btcscan.org/tx/',
    tokens: {}
}; 