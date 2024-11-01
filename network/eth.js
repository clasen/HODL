import Web3Network from './lib/Web3Network.js';

export default {
    name: 'Ethereum',
    NetworkClass: Web3Network,
    rpcUrl: 'https://eth.public-rpc.com',
    nativeToken: 'ETH',
    explorer: 'https://etherscan.io/tx/',
    tokens: {
        'USDT': {
            address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        }
    }
}; 