import Web3Network from './lib/Web3Network.js';

export default {
    NetworkClass: Web3Network,
    name: '[ERC-20] Optimism',
    explorer: 'https://optimistic.etherscan.io/tx/',
    url: 'https://mainnet.optimism.io',
    nativeToken: 'OP',
    tokens: {
        'USDT': {
            address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
        }
    },
};
