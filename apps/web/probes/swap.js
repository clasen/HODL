import { SwapService } from 'hodl-wallet/browser/index.js';
import { TestStore, check } from './store.js';

export async function run() {
    const db = new TestStore();
    await db.set('account', 'BitcoinNetwork', { address: 'fixture-btc', privateKey: 'fixture-key' });
    const service = new SwapService(db);
    const destination = await service.destination();
    check(destination === 'fixture-btc', 'Swap did not use the store contract.');
    check((await db.get('account', 'BitcoinNetwork')).privateKey === 'fixture-key', 'Swap cleared stored secrets.');
    return { destination, operations: await service.list() };
}
