import TONNetwork from './lib/TONNetwork.js';

async function getEndpoint() {
    try {
        const { getHttpEndpoint } = await import('@orbs-network/ton-access');
        return await getHttpEndpoint();
    } catch {
        // Fallback to public endpoint if @orbs-network/ton-access is not available
        return 'https://toncenter.com/api/v2/jsonRPC';
    }
}

export default {
    name: '[TON] The Open Network',
    NetworkClass: TONNetwork,
    url: await getEndpoint(),
    nativeToken: 'TON',
    explorer: 'https://tonscan.org/tx/',
    tokens: {
        'USDT': {
            address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
        }
    }
}; 