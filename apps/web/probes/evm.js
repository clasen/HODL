import { NetworkRegistry, Web3Network } from 'hodl-wallet/browser/index.js';

export async function run() {
    const network = new Web3Network({ ...new NetworkRegistry().get('bsc'), url: 'http://127.0.0.1:1' });
    const account = await network.accountFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    try {
        if (!network.validateAddress(account.address) || network.validateAddress('invalid')) {
            throw new Error('EVM address validation failed.');
        }
        const transaction = await account.signTransaction({
            to: account.address, value: '123456789', nonce: 0,
            gas: 21000, gasPrice: '1000000000', chainId: 56, networkId: 56, type: '0x0'
        });
        if (!transaction.transactionHash) throw new Error('EVM signing failed.');
        return { address: account.address, signature: account.sign('HODL browser compatibility').signature,
            transactionHash: transaction.transactionHash };
    } finally { account.privateKey = ''; account.mnemonic = ''; }
}
