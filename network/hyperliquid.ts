import Web3Network from './lib/Web3Network.js';
import type { NetworkPlugin } from './types.js';

const hyperliquid = {
    NetworkClass: Web3Network,
    name: '[ERC-20] Hyperliquid',
    url: 'https://rpc.hyperliquid.xyz/evm',
    nativeToken: 'HYPE',
    explorer: 'https://hyperscan.com/tx/',
    chainId: 999,
    tokens: {
        'PURR': {
            address: '0x9b498C3c8A0b8CD8BA1D9851d40D186F1872b44E',
        }
    }
} satisfies NetworkPlugin;

export default hyperliquid;
