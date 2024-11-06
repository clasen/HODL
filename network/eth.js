import Web3Network from './lib/Web3Network.js';

export default {
    NetworkClass: Web3Network,
    name: '[ERC-20] Ethereum',
    url: 'https://eth.public-rpc.com',
    nativeToken: 'ETH',
    explorer: 'https://etherscan.io/tx/',
    tokens: {
        'USDT': {
            address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        }
    }
}; 