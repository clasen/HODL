import { TransferService, NetworkRegistry, BitcoinNetwork } from 'hodl-wallet/browser/index.js';
import { TestStore, check } from './store.js';

export async function run() {
    let db = new TestStore();
    let signs = 0;
    let broadcasts = 0;
    let confirmed = false;
    const request = { wallet: 'fixture', to: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', asset: 'BTC', amount: '0.001', dryRun: false, requestId: 'browser-transfer' };
    class TestNetwork extends BitcoinNetwork {
        async prepareTransfer(from, to, amount, asset) {
            signs++;
            return { from: from.address, to, amount, asset, amountBaseUnits: '100000',
                fee: { asset: 'BTC', amount: '0.00001', baseUnits: '1000', decimals: 8, estimated: true },
                rawTransaction: 'fixture-bytes', transactionHash: 'a'.repeat(64) };
        }
        async sendSignedTransaction() {
            check(db.durable.sendRequest[request.requestId].state === 'broadcasting', 'Broadcast preceded durable write.');
            broadcasts++;
            throw new Error('Response lost');
        }
        async getTransactionStatus(transactionHash) {
            return { state: confirmed ? 'confirmed' : 'not_found', transactionHash };
        }
    }
    const plugin = { ...new NetworkRegistry().get('btc'), NetworkClass: TestNetwork };
    const service = () => new TransferService(db, plugin, new TestNetwork(plugin));
    await db.set('account', TestNetwork.name, { address: request.to, privateKey: 'fixture-key' });
    db.failFlush = true;
    let failure;
    try { await service().send(request); } catch (error) { failure = error.message; }
    check(failure === 'Storage unavailable', `Unexpected preparation failure: ${failure}`);
    check(broadcasts === 0, 'Storage failure permitted broadcast.');
    db.failFlush = false;
    let code;
    try { await service().send(request); } catch (error) { code = error.code; }
    check(code === 'BROADCAST_UNKNOWN', 'Lost response was not recorded as unknown.');
    db = new TestStore(db.durable);
    confirmed = true;
    const recovered = await service().send(request);
    const repeated = await service().send(request);
    check(recovered.status === 'confirmed' && repeated.status === 'confirmed', 'Recovery failed.');
    check(signs === 1 && broadcasts === 1, 'Recovery repeated a signature or broadcast.');
    check(!('rawTransaction' in recovered), 'Public result exposed signed bytes.');
    check((await db.get('account', TestNetwork.name)).privateKey === 'fixture-key', 'Read mutated stored secrets.');
    return { signs, broadcasts, status: recovered.status, fingerprint: db.durable.sendRequest[request.requestId].fingerprint };
}
