import Web3Network from './lib/Web3Network.js';
import type { NetworkPlugin } from './types.js';

const ethereum = {
    NetworkClass: Web3Network,
    id: 'eth',
    family: 'evm',
    chainId: 1,
    name: '[ETH] Ethereum',
    storageName: '[ERC-20] Ethereum',
    url: 'https://ethereum.publicnode.com',
    nativeToken: 'ETH',
    explorer: 'https://etherscan.io/tx/',
    history: {
        url: 'https://ethereum-rpc.publicnode.com',
        blockRange: 5_000,
        lookbackBlocks: 10_000,
        catchUpBlocks: 10_000
    },
    tokens: {
        'USDT': {
            address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        }
    }
} satisfies NetworkPlugin;

export default ethereum;
