import { NetworkRegistry } from 'hodl-wallet/browser/index.js';

export async function run() {
    return { networks: new NetworkRegistry().list().map(network => ({ id: network.id, storageKey: network.NetworkClass.name })) };
}
