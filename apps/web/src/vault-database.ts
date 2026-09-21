import { webConfig } from '../config.mjs';
import { VaultError } from './vault-error.js';
import { parseEnvelope, type VaultEnvelope } from './vault-crypto.js';

const config = webConfig.vault;

function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const request = indexedDB.open(config.database, config.databaseVersion);
        request.onupgradeneeded = () => request.result.createObjectStore(config.store);
        request.onerror = () => { settled = true; reject(new VaultError('Could not open browser storage.')); };
        request.onblocked = () => { settled = true; reject(new VaultError('Close other HODL tabs to open storage.')); };
        request.onsuccess = () => {
            if (settled) { request.result.close(); return; }
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };
    });
}

export async function readEnvelope(): Promise<VaultEnvelope | undefined> {
    const db = await open();
    try {
        const value = await new Promise<unknown>((resolve, reject) => {
            const tx = db.transaction(config.store, 'readonly');
            const request = tx.objectStore(config.store).get(config.record);
            tx.oncomplete = () => resolve(request.result);
            tx.onabort = () => reject(new VaultError('Could not read the vault.'));
        });
        return value === undefined ? undefined : parseEnvelope(value);
    } finally { db.close(); }
}

export async function writeEnvelope(envelope: VaultEnvelope, previous?: VaultEnvelope): Promise<void> {
    const db = await open();
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(config.store, 'readwrite', { durability: 'strict' });
            const store = tx.objectStore(config.store);
            let failure = new VaultError('Could not save the vault. Check browser storage space and permissions.');
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(failure);
            const current = store.get(config.record);
            current.onsuccess = () => {
                try {
                    if (previous === undefined) {
                        if (current.result !== undefined) {
                            failure = new VaultError('A wallet already exists in this browser. It was not replaced.');
                            tx.abort();
                        } else store.add(envelope, config.record);
                    } else if (JSON.stringify(current.result) !== JSON.stringify(previous)) {
                        failure = new VaultError('The vault changed outside this session. Lock and unlock it again.');
                        tx.abort();
                    } else store.put(envelope, config.record);
                } catch {
                    try { tx.abort(); } catch { reject(failure); }
                }
            };
        });
    } finally { db.close(); }
}
