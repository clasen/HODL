import arb from './network/arb.js';
import avax from './network/avax.js';
import bsc from './network/bsc.js';
import btc from './network/btc.js';
import eth from './network/eth.js';
import ftm from './network/ftm.js';
import hyperliquid from './network/hyperliquid.js';
import op from './network/op.js';
import pol from './network/pol.js';
import type { NetworkPlugin, NetworkUsage, NetworkUsageEntry } from './network/types.js';

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

export function networkStorageName(network: NetworkPlugin): string {
    return network.storageName ?? network.name;
}

export function isNetworkUsageEntry(value: unknown): value is NetworkUsageEntry {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        typeof (value as Partial<NetworkUsageEntry>).count === 'number'
    );
}

/** Most recently used first; networks with no use time fall back to how often they were used. */
export function byRecentUse(networks: readonly NetworkPlugin[], usage: NetworkUsage): NetworkPlugin[] {
    const lastUsed = (network: NetworkPlugin): number => {
        const entry = usage[networkStorageName(network)];
        return typeof entry === 'object' ? entry.lastUsed || 0 : 0;
    };
    const count = (network: NetworkPlugin): number => {
        const entry = usage[networkStorageName(network)];
        return typeof entry === 'number' ? entry : entry?.count || 0;
    };
    return [...networks].sort((a, b) => {
        if (lastUsed(a) === 0 && lastUsed(b) === 0) return count(b) - count(a);
        return lastUsed(b) - lastUsed(a);
    });
}

/** Counts one more use of the network, now. */
export function recordNetworkUse(usage: NetworkUsage, network: NetworkPlugin): void {
    const current = usage[networkStorageName(network)];
    const count = typeof current === 'number' ? current : isNetworkUsageEntry(current) ? current.count : 0;
    usage[networkStorageName(network)] = { count: count + 1, lastUsed: Date.now() };
}

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
