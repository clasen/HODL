import Web3Network from './lib/Web3Network.js';

export default {
    NetworkClass: Web3Network,
    name: '[ERC-20] Polygon',
    explorer: 'https://polygonscan.com/tx/',
    url: 'https://polygon-rpc.com/',
    nativeToken: 'POL',
    tokens: {
        'USDT': {
            address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
        }
    },
};
