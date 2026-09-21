import { NetworkRegistry, BitcoinNetwork } from 'hodl-wallet/browser/index.js';
import { sha256 } from 'hodl-wallet/dist/environment.js';

export async function run() {
    const network = new BitcoinNetwork(new NetworkRegistry().get('btc'));
    const account = await network.accountFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    try {
        if (!network.validateAddress(account.address) || network.validateAddress('invalid')) {
            throw new Error('Bitcoin address validation failed.');
        }
        const txid = 'bef2fee5987d0342d59da1fd5c39a7cabed6646887898d7aaed88c59e2d7e131';
        network.getUTXOs = async () => [{ txid, vout: 0, value: 200000 }];
        network.getTransaction = async id => {
            if (id !== txid) throw new Error('Unexpected fixture transaction.');
            return '010000000101010101010101010101010101010101010101010101010101010101010101010000000000ffffffff01400d030000000000160014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e200000000';
        };
        const transaction = await network.prepareTransfer(account, account.address, '0.001', 'BTC', { feeRate: 2 });
        return { address: account.address, transactionHash: transaction.transactionHash,
            signedBytesDigest: await sha256(transaction.rawTransaction), fee: transaction.fee.amount };
    } finally { account.privateKey = ''; account.mnemonic = ''; }
}
