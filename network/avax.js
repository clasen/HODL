import Web3Network from './lib/Web3Network.js';

export default {
    NetworkClass: Web3Network,
    name: '[ERC-20] Avalanche C-Chain',
    url: 'https://api.avax.network/ext/bc/C/rpc',
    explorer: 'https://snowtrace.io/tx/',
    nativeToken: 'AVAX',
    tokens: {
        'USDT': {
            address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
        }
    },
};
