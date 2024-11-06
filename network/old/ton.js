import TONNetwork from './lib/TONNetwork.js';
import { getHttpEndpoint } from '@orbs-network/ton-access';

export default {
    name: '[TON] The Open Network',
    NetworkClass: TONNetwork,
    url: await getHttpEndpoint(),
    nativeToken: 'TON',
    explorer: 'https://tonscan.org/tx/',
    tokens: {
        'USDT': {
            address: 'EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA'
        }
    }
}; 