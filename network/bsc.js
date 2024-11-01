import Web3Network from './lib/Web3Network.js';

export default {
    name: 'BSC',
    NetworkClass: Web3Network,
    rpcUrl: 'https://bsc-dataseed1.binance.org',
    nativeToken: 'BNB',
    explorer: 'https://bscscan.com/tx/',
    tokens: {
        'USDT': {
            address: '0x55d398326f99059fF775485246999027B3197955',
        }
    }
}; 