import Web3Network from './lib/Web3Network.js';

export default {
    NetworkClass: Web3Network,
    name: '[ERC-20] Fantom',
    explorer: 'https://ftmscan.com/tx/',
    url: 'https://rpc.ftm.tools/',
    nativeToken: 'FTM',
    tokens: {
        'USDT': {
            address: '0x049d68029688eAbF473097a2fC38ef61633A3C7A',
        }
    },
};
