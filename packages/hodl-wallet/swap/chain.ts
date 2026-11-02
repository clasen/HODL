import { encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as bitcoin from 'bitcoinjs-lib';
import { swapConfig as config } from './config.js';
import { evmAddress, integer, list, record, swapJson, swapText, textField, transactionHash } from './http.js';
import type { ChainReceipt, FundingEstimate, ProviderQuote, SwapChain, SwapInput, SwapPlan, SwapQuote, SwapStep } from './types.js';
import type { WalletAccount } from '../network/types.js';

const abi = parseAbi([
    'function approve(address spender, uint256 amount)',
    'function allowance(address owner, address spender)',
    'function transfer(address to, uint256 amount)',
    'function depositWithExpiry(address vault, address asset, uint256 amount, string memo, uint256 expiry)'
]);

function hex(value: unknown): bigint {
    if (typeof value !== 'string' || !/^0x[\da-f]+$/i.test(value)) throw new Error('Invalid RPC number.');
    return BigInt(value);
}

export class BscPayments {
    protected async rpc(method: string, params: unknown[]): Promise<unknown> {
        const response = record(await swapJson(config.source.url, { jsonrpc: '2.0', id: 1, method, params }));
        if (response.error || !('result' in response)) throw new Error(`BSC RPC ${method} failed.`);
        return response.result;
    }

    protected async assertChain(): Promise<void> {
        if (hex(await this.rpc('eth_chainId', [])) !== BigInt(config.source.chainId)) {
            throw new Error('BSC RPC chain ID mismatch.');
        }
    }

    async blockNumber(): Promise<bigint> { return hex(await this.rpc('eth_blockNumber', [])); }

    private async confirmedReceipt(hash: string): Promise<{ receipt: Record<string, unknown> | null; confirmations: number }> {
        await this.assertChain();
        const value = await this.rpc('eth_getTransactionReceipt', [transactionHash(hash, true)]);
        if (value === null) return { receipt: null, confirmations: 0 };
        const receipt = record(value);
        if (transactionHash(receipt.transactionHash, true) !== transactionHash(hash, true)) throw new Error('Receipt hash mismatch.');
        const block = hex(receipt.blockNumber);
        const [tip, canonical] = await Promise.all([
            this.blockNumber(), this.rpc('eth_getBlockByNumber', [`0x${block.toString(16)}`, false])
        ]);
        if (tip < block || record(canonical).hash !== receipt.blockHash) return { receipt: null, confirmations: 0 };
        return { receipt, confirmations: Number(tip - block + 1n) };
    }

    async receipt(hash: string): Promise<ChainReceipt> {
        const { receipt, confirmations } = await this.confirmedReceipt(hash);
        if (!receipt) {
            const transaction = await this.rpc('eth_getTransactionByHash', [transactionHash(hash, true)]);
            if (transaction === null) return { state: 'not_found', confirmations: 0 };
            if (transactionHash(record(transaction).hash, true) !== transactionHash(hash, true)) throw new Error('Pending transaction hash mismatch.');
            return { state: 'pending', confirmations: 0 };
        }
        if (confirmations < config.bscConfirmations) return { state: 'pending', confirmations };
        const status = hex(receipt.status);
        if (status !== 0n && status !== 1n) throw new Error('Invalid receipt status.');
        return { state: status === 1n ? 'confirmed' : 'reverted', confirmations };
    }

    async payment(hash: string, address: string): Promise<{ amount: bigint; confirmations: number }> {
        const { receipt, confirmations } = await this.confirmedReceipt(hash);
        if (!receipt) return { amount: 0n, confirmations: 0 };
        if (hex(receipt.status) !== 1n) throw new Error('Refund transaction reverted.');
        const transferTopic = keccak256(toBytes('Transfer(address,address,uint256)'));
        const recipient = `0x${evmAddress(address).slice(2).toLowerCase().padStart(64, '0')}`;
        let amount = 0n;
        for (const value of list(receipt.logs)) {
            const log = record(value);
            if (textField(log.address).toLowerCase() !== config.token.toLowerCase()) continue;
            const topics = list(log.topics);
            if (topics[0] === transferTopic && typeof topics[2] === 'string' && topics[2].toLowerCase() === recipient) {
                amount += hex(log.data);
            }
        }
        return { amount, confirmations };
    }
}

export class BitcoinPayments {
    async payment(hash: string, address: string): Promise<{ amount: bigint; confirmations: number }> {
        const id = transactionHash(hash);
        const tx = record(await swapJson(`${config.destination.url}/tx/${id}`));
        if (transactionHash(tx.txid) !== id) throw new Error('Bitcoin transaction hash mismatch.');
        const script = Buffer.from(bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin)).toString('hex');
        let sats = 0n;
        for (const entry of list(tx.vout)) {
            const output = record(entry);
            if (output.scriptpubkey === script) sats += BigInt(integer(output.value));
        }
        return { amount: sats, confirmations: await this.confirmations(record(tx.status)) };
    }

    async blockNumber(): Promise<bigint> {
        const value = (await swapText(`${config.destination.url}/blocks/tip/height`)).trim();
        if (!/^\d+$/.test(value)) throw new Error('Invalid Bitcoin tip height.');
        return BigInt(value);
    }

    protected async confirmations(status: Record<string, unknown>): Promise<number> {
        if (status.confirmed !== true) return 0;
        const height = integer(status.block_height);
        const [tip, canonical] = await Promise.all([
            this.blockNumber(), swapText(`${config.destination.url}/block-height/${height}`)
        ]);
        return canonical.trim() === textField(status.block_hash) ? Math.max(0, Number(tip) - height + 1) : 0;
    }

}

export class BscSwapChain extends BscPayments implements SwapChain {
    async availableBalance(address: string): Promise<bigint> {
        return (await this.checkSource(address)).balance;
    }

    async checkSource(address: string): Promise<{ balance: bigint; nativeBalance: bigint; gasPrice: bigint }> {
        evmAddress(address);
        await this.assertChain();
        const [balance, nativeBalance, gasPrice, decimals] = await Promise.all([
            this.rpc('eth_call', [{ to: config.token, data: `0x70a08231${address.slice(2).padStart(64, '0')}` }, 'latest']),
            this.rpc('eth_getBalance', [address, 'latest']),
            this.rpc('eth_gasPrice', []),
            this.rpc('eth_call', [{ to: config.token, data: '0x313ce567' }, 'latest'])
        ]);
        if (hex(decimals) !== BigInt(config.decimals)) throw new Error('Unexpected BSC USDT decimals.');
        if (hex(gasPrice) <= 0n) throw new Error('Invalid BSC gas price.');
        return { balance: hex(balance), nativeBalance: hex(nativeBalance), gasPrice: hex(gasPrice) };
    }

    async allowance(address: string, router: string): Promise<bigint> {
        await this.assertChain();
        const data = encodeFunctionData({ abi, functionName: 'allowance', args: [evmAddress(address) as Address, evmAddress(router) as Address] });
        return hex(await this.rpc('eth_call', [{ to: config.token, data }, 'latest']));
    }

    async assertNonceAvailable(address: string): Promise<void> {
        const [latest, pending] = await Promise.all([
            this.rpc('eth_getTransactionCount', [address, 'latest']),
            this.rpc('eth_getTransactionCount', [address, 'pending'])
        ]);
        if (hex(latest) !== hex(pending)) throw new Error('An outgoing BSC transaction is still pending.');
    }

    async sign(quote: SwapQuote, plan: SwapPlan, kind: SwapStep['kind'], account: WalletAccount): Promise<SwapStep> {
        await this.assertChain();
        const signer = privateKeyToAccount(account.privateKey as Hex);
        if (signer.address.toLowerCase() !== quote.from.toLowerCase()) {
            throw new Error('Swap signer does not match source account.');
        }
        await this.assertNonceAvailable(quote.from);
        let to = config.token as Address;
        let data: Hex;
        let limit: number = config.gas.approval;
        if (kind !== 'deposit') {
            if (quote.provider !== 'thorchain' || plan.router !== config.thorchain.router) throw new Error('Invalid approval router.');
            data = encodeFunctionData({ abi, functionName: 'approve', args: [plan.router as Address, kind === 'approve' ? BigInt(quote.amountBaseUnits) : 0n] });
        } else if (quote.provider !== 'thorchain') {
            data = encodeFunctionData({ abi, functionName: 'transfer', args: [evmAddress(plan.depositAddress) as Address, BigInt(quote.amountBaseUnits)] });
            limit = config.gas.transfer;
        } else {
            if (plan.router !== config.thorchain.router || !plan.memo || !plan.expirySeconds) throw new Error('Invalid THORChain deposit.');
            to = plan.router as Address;
            data = encodeFunctionData({ abi, functionName: 'depositWithExpiry', args: [
                evmAddress(plan.depositAddress) as Address, config.token as Address, BigInt(quote.amountBaseUnits), plan.memo, BigInt(plan.expirySeconds)
            ] });
            limit = config.gas.deposit;
        }
        const nonce = hex(await this.rpc('eth_getTransactionCount', [quote.from, 'pending']));
        const gasPrice = BigInt(quote.funding.rate);
        const request = { from: quote.from, to, data, value: '0x0', gasPrice: `0x${gasPrice.toString(16)}` };
        const estimate = hex(await this.rpc('eth_estimateGas', [request]));
        if (estimate > BigInt(limit)) throw new Error('Gas exceeds the accepted budget; obtain a new quote.');
        const rawTransaction = await signer.signTransaction({
            to, data, value: 0n, nonce: Number(nonce), gas: BigInt(limit), gasPrice, chainId: config.source.chainId, type: 'legacy'
        });
        return {
            kind, nonce: nonce.toString(), rawTransaction,
            hash: transactionHash(keccak256(rawTransaction), true), confirmed: false, broadcastAttempted: false
        };
    }

    async broadcast(step: SwapStep): Promise<void> {
        await this.assertChain();
        const hash = transactionHash(await this.rpc('eth_sendRawTransaction', [step.rawTransaction]), true);
        if (hash !== step.hash) throw new Error('RPC returned an unexpected transaction hash.');
    }

    async estimate(input: SwapInput, offer: ProviderQuote): Promise<FundingEstimate> {
        const source = await this.checkSource(input.from);
        let gasUnits: number = config.gas.transfer;
        if (offer.provider === 'thorchain') {
            gasUnits = config.gas.deposit;
            const allowance = await this.allowance(input.from, config.thorchain.router);
            if (allowance < BigInt(input.amountBaseUnits)) gasUnits += config.gas.approval * (allowance > 0n ? 2 : 1);
        }
        const recommended = offer.provider === 'thorchain' ? BigInt(textField(offer.details.gasPrice)) : 0n;
        const rate = source.gasPrice > recommended ? source.gasPrice : recommended;
        return { asset: 'BNB', decimals: 18, price: 'bnb', rate: rate.toString(), units: gasUnits, budgetBaseUnits: (rate * BigInt(gasUnits)).toString() };
    }

    async balance(input: SwapInput, funding: FundingEstimate) {
        const source = await this.checkSource(input.from);
        return { sufficientAsset: source.balance >= BigInt(input.amountBaseUnits), sufficientFee: source.nativeBalance >= BigInt(funding.budgetBaseUnits) };
    }

    async checkFunding(quote: SwapQuote, steps: SwapStep[]): Promise<void> {
        const source = await this.checkSource(quote.from);
        if (source.balance < BigInt(quote.amountBaseUnits)) throw new Error('Insufficient USDT on BSC.');
        const consumed = steps.filter(step => step.confirmed).length * config.gas.approval;
        const remaining = BigInt(quote.funding.units - consumed) * BigInt(quote.funding.rate);
        if (source.nativeBalance < remaining) throw new Error('Insufficient BNB for the accepted gas budget.');
        if (source.gasPrice > BigInt(quote.funding.rate)) throw new Error('BSC gas price increased; obtain a new quote.');
    }

    async assertAvailable(address: string): Promise<void> { await this.assertNonceAvailable(address); }

    async nextStep(quote: SwapQuote, plan: SwapPlan, steps: SwapStep[]): Promise<SwapStep['kind']> {
        let kind: SwapStep['kind'] = 'deposit';
        if (plan.router) {
            const allowance = await this.allowance(quote.from, plan.router);
            if (allowance < BigInt(quote.amountBaseUnits)) kind = allowance > 0n ? 'reset_approval' : 'approve';
        }
        const spent = steps.reduce((sum, step) => sum + (step.kind === 'deposit' ? config.gas.deposit : config.gas.approval), 0);
        const next = kind === 'deposit' ? (quote.provider === 'thorchain' ? config.gas.deposit : config.gas.transfer) : config.gas.approval;
        if (spent + next > quote.funding.units) throw new Error('Funding requirements exceed the accepted gas budget.');
        return kind;
    }

    async payoutPayment(hash: string, address: string) { return new BitcoinPayments().payment(hash, address); }
    async refundPayment(hash: string, address: string) { return this.payment(hash, address); }
}
