import arb from './network/arb.js';
import avax from './network/avax.js';
import bsc from './network/bsc.js';
import btc from './network/btc.js';
import eth from './network/eth.js';
import ftm from './network/ftm.js';
import hyperliquid from './network/hyperliquid.js';
import op from './network/op.js';
import pol from './network/pol.js';
import type { NetworkPlugin } from './network/types.js';

export const ACTIVE_NETWORKS: readonly NetworkPlugin[] = Object.freeze([
    btc,
    eth,
    bsc,
    pol,
    arb,
    op,
    ftm,
    avax,
    hyperliquid
]);

export class NetworkRegistry {
    private readonly byId: Map<string, NetworkPlugin>;

    constructor(networks: readonly NetworkPlugin[] = ACTIVE_NETWORKS) {
        this.byId = new Map();
        for (const network of networks) {
            if (this.byId.has(network.id)) {
                throw new Error(`Duplicate network ID: ${network.id}`);
            }
            this.byId.set(network.id, network);
        }
    }

    list(): NetworkPlugin[] {
        return [...this.byId.values()];
    }

    get(id: string): NetworkPlugin {
        const network = this.byId.get(id);
        if (!network) {
            throw new Error(`Unsupported network: ${id}`);
        }
        return network;
    }

    firstForFamily(family: NetworkPlugin['family']): NetworkPlugin {
        const network = this.list().find(candidate => candidate.family === family);
        if (!network) {
            throw new Error(`No network registered for family: ${family}`);
        }
        return network;
    }
}
