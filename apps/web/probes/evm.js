import { privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem';
import { NetworkRegistry, Web3Network } from 'hodl-wallet/browser/index.js';

export async function run() {
    const network = new Web3Network({ ...new NetworkRegistry().get('bsc'), url: 'http://127.0.0.1:1' });
    const account = await network.accountFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    try {
        if (!network.validateAddress(account.address) || network.validateAddress('invalid')) {
            throw new Error('EVM address validation failed.');
        }
        const signer = privateKeyToAccount(account.privateKey);
        const rawTransaction = await signer.signTransaction({
            to: account.address, value: 123456789n, nonce: 0,
            gas: 21000n, gasPrice: 1000000000n, chainId: 56, type: 'legacy'
        });
        return { address: account.address, signature: await signer.signMessage({ message: 'HODL browser compatibility' }),
            transactionHash: keccak256(rawTransaction) };
    } finally { account.privateKey = ''; account.mnemonic = ''; }
}
