import BitcoinNetwork from './lib/BTCNetwork.js';

export default {
    name: 'Bitcoin',
    NetworkClass: BitcoinNetwork,
    apiUrl: 'https://blockstream.info/api',
    rpcUrl: 'https://btc.public-rpc.com',
    nativeToken: 'BTC',
    explorer: 'https://blockstream.info/tx/',
    tokens: {} // Bitcoin nativo no tiene tokens como Ethereum
}; 