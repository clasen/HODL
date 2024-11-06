import Web3Network from './lib/Web3Network.js';

export default {
    name: '[ERC-20] Arbitrum One',
    NetworkClass: Web3Network,
    explorer: 'https://arbiscan.io/tx/',
    url: 'https://arb1.arbitrum.io/rpc',
    nativeToken: 'ARB',
    tokens: {
        'USDT': {
            address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        }
    },
};
