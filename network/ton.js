import TONNetwork from './lib/TONNetwork.js';
import { getHttpEndpoint } from '@orbs-network/ton-access';

export default {
    name: 'TON',
    NetworkClass: TONNetwork,
    rpcUrl: await getHttpEndpoint(),
    nativeToken: 'TON',
    explorer: 'https://tonscan.org/tx/',
    tokens: {
        'USDT': {
            address: 'EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA'
        }
    }
}; 