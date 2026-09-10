import * as bitcoin from 'bitcoinjs-lib';
import BitcoinNetwork, { signBitcoinTransaction } from '../network/lib/BitcoinNetwork.js';
import type { WalletAccount } from '../network/types.js';
import { BscPayments, BitcoinPayments } from './chain.js';
import { swapConfig as config } from './config.js';
import { integer, list, record, swapJson, swapText, SwapHttpError, textField, transactionHash, units } from './http.js';
import type { BitcoinInput, ChainReceipt, FundingEstimate, ProviderQuote, SwapChain, SwapInput, SwapPlan, SwapQuote, SwapStep } from './types.js';

type Output = { script: Buffer; value: number };

export function bitcoinMemoOutputs(memo?: string): Output[] {
    if (memo === undefined) return [];
    if (!memo || !/^[\x20-\x7e]+$/.test(memo)) throw new Error('Invalid Bitcoin swap memo.');
    const bytes = Buffer.from(memo, 'ascii');
    const first = bytes.length <= 80 ? bytes : Buffer.concat([bytes.subarray(0, 79), Buffer.from('^')]);
    const outputs = [{ script: bitcoin.payments.embed({ data: [first] }).output!, value: 0 }];
    for (let offset = 79; bytes.length > 80 && offset < bytes.length; offset += 20) {
        const chunk = Buffer.alloc(20);
        bytes.copy(chunk, 0, offset, offset + 20);
        outputs.push({ script: Buffer.concat([Buffer.from('0014', 'hex'), chunk]), value: config.bitcoin.memoDustSats });
    }
    if (outputs.length + 2 > config.bitcoin.maxOutputs) throw new Error('Bitcoin swap memo exceeds the supported output limit.');
    return outputs;
}

export class BitcoinSwapChain extends BitcoinPayments implements SwapChain {
    private readonly network = new BitcoinNetwork(config.destination);

    private async utxos(address: string): Promise<BitcoinInput[]> {
        bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin);
        const values = list(await swapJson(`${config.destination.url}/address/${address}/utxo`)).map(record);
        const seen = new Set<string>();
        return values.filter(value => record(value.status).confirmed === true).map(value => {
            const input = { txid: transactionHash(value.txid), vout: integer(value.vout), value: integer(value.value) };
            const key = `${input.txid}:${input.vout}`;
            if (seen.has(key) || input.value === 0) throw new Error('Invalid Bitcoin UTXO list.');
            seen.add(key);
            return input;
        });
    }

    private async feeRate(offer?: ProviderQuote): Promise<bigint> {
        const estimates = record(await swapJson(`${config.destination.url}/fee-estimates`));
        const value = estimates[String(config.bitcoin.feeTargetBlocks)];
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('Invalid Bitcoin fee estimate.');
        const rate = BigInt(Math.ceil(value));
        const recommended = offer?.provider === 'thorchain' ? units(offer.details.gasPrice) : 0n;
        return rate > recommended ? rate : recommended;
    }

    async availableBalance(address: string): Promise<bigint> {
        return (await this.utxos(address)).reduce((sum, utxo) => sum + BigInt(utxo.value), 0n);
    }

    async estimate(input: SwapInput, offer: ProviderQuote): Promise<FundingEstimate> {
        const [utxos, rate] = await Promise.all([this.utxos(input.from), this.feeRate(offer)]);
        const memo = bitcoinMemoOutputs(offer.provider === 'thorchain' ? textField(offer.details.memo) : undefined);
        const memoValue = memo.reduce((sum, output) => sum + BigInt(output.value), 0n);
        const extraBytes = memo.reduce((sum, output) => sum + 8 + 1 + output.script.length, 0);
        const selected: BitcoinInput[] = [];
        let value = 0n;
        let size = 0;
        for (const utxo of utxos) {
            selected.push(utxo);
            value += BigInt(utxo.value);
            // SegWit input upper bound, 34-byte deposit script and P2WPKH change.
            size = 11 + selected.length * 69 + 43 + 31 + extraBytes;
            if (value >= BigInt(input.amountBaseUnits) + BigInt(size) * rate + memoValue + BigInt(config.bitcoin.changeDustSats)) break;
        }
        if (!selected.length) throw new Error('No confirmed Bitcoin UTXOs are available.');
        return {
            asset: 'BTC', decimals: 8, price: 'btc', rate: rate.toString(), units: size,
            budgetBaseUnits: (BigInt(size) * rate + memoValue).toString(), inputs: selected
        };
    }

    async balance(input: SwapInput, funding: FundingEstimate) {
        const available = await this.utxos(input.from);
        const total = available.reduce((sum, utxo) => sum + BigInt(utxo.value), 0n);
        return {
            sufficientAsset: total >= BigInt(input.amountBaseUnits),
            sufficientFee: total >= BigInt(input.amountBaseUnits) + BigInt(funding.budgetBaseUnits) + BigInt(config.bitcoin.changeDustSats)
        };
    }

    async assertAvailable(address: string): Promise<void> {
        const script = bitcoin.address.toOutputScript(address).toString('hex');
        const pending = list(await swapJson(`${config.destination.url}/address/${address}/txs/mempool`)).map(record);
        if (pending.some(tx => list(tx.vin).some(input => record(record(input).prevout).scriptpubkey === script))) {
            throw new Error('An outgoing Bitcoin transaction is still pending.');
        }
    }

    async checkFunding(quote: SwapQuote): Promise<void> {
        const inputs = quote.funding.inputs;
        if (!inputs?.length) throw new Error('Bitcoin quote has no selected inputs.');
        const [available, rate] = await Promise.all([this.utxos(quote.from), this.feeRate()]);
        for (const input of inputs) {
            if (!available.some(utxo => utxo.txid === input.txid && utxo.vout === input.vout && utxo.value === input.value)) {
                throw new Error('A selected Bitcoin input is no longer available; obtain a new quote.');
            }
        }
        if (rate > BigInt(quote.funding.rate)) throw new Error('Bitcoin fee rate increased; obtain a new quote.');
        const total = inputs.reduce((sum, input) => sum + BigInt(input.value), 0n);
        if (total < BigInt(quote.amountBaseUnits) + BigInt(quote.funding.budgetBaseUnits) + BigInt(config.bitcoin.changeDustSats)) {
            throw new Error('Insufficient BTC for the deposit, fee and refund-address change.');
        }
    }

    async nextStep(): Promise<'deposit'> { return 'deposit'; }

    async sign(quote: SwapQuote, plan: SwapPlan, kind: SwapStep['kind'], account: WalletAccount): Promise<SwapStep> {
        if (kind !== 'deposit' || quote.routeId !== 'btc-bsc' || plan.router) throw new Error('Invalid Bitcoin funding step.');
        const signer = await this.network.privateKeyToAccount(account.privateKey);
        if (signer.address !== quote.from || account.address !== quote.from) throw new Error('Swap signer does not match source account.');
        await this.assertAvailable(quote.from);
        await this.checkFunding(quote);
        const inputs = quote.funding.inputs!;
        const script = bitcoin.address.toOutputScript(quote.from, bitcoin.networks.bitcoin);
        const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
        psbt.setVersion(2);
        psbt.setLocktime(0);
        let total = 0n;
        for (const input of inputs) {
            const raw = await swapText(`${config.destination.url}/tx/${input.txid}/hex`);
            const parent = bitcoin.Transaction.fromHex(raw.trim());
            const output = parent.outs[input.vout];
            if (parent.getId() !== input.txid || !output || output.value !== input.value || !output.script.equals(script)) {
                throw new Error('Bitcoin funding input does not match the source wallet.');
            }
            if (quote.provider === 'thorchain' && parent.outs.length > config.bitcoin.maxOutputs) {
                throw new Error('THORChain does not accept this Bitcoin parent transaction.');
            }
            psbt.addInput({ hash: input.txid, index: input.vout, nonWitnessUtxo: Buffer.from(raw.trim(), 'hex'), sequence: 0xffffffff });
            total += BigInt(input.value);
        }
        const amount = BigInt(quote.amountBaseUnits);
        const change = total - amount - BigInt(quote.funding.budgetBaseUnits);
        if (amount > BigInt(Number.MAX_SAFE_INTEGER) || change > BigInt(Number.MAX_SAFE_INTEGER) || change < BigInt(config.bitcoin.changeDustSats)) {
            throw new Error('Invalid Bitcoin deposit or change amount.');
        }
        const memo = bitcoinMemoOutputs(quote.provider === 'thorchain' ? textField(plan.memo) : undefined);
        const memoCost = memo.reduce((sum, output) => sum + BigInt(output.value), 0n);
        psbt.addOutput({ address: plan.depositAddress, value: Number(amount) });
        psbt.addOutput({ address: quote.from, value: Number(change) });
        for (const output of memo) psbt.addOutput(output);
        signBitcoinTransaction(psbt, account.privateKey, bitcoin.networks.bitcoin);
        const transaction = psbt.extractTransaction();
        const minerFee = BigInt(quote.funding.budgetBaseUnits) - memoCost;
        if (minerFee < BigInt(transaction.virtualSize()) * BigInt(quote.funding.rate)) {
            throw new Error('Bitcoin transaction exceeds the accepted fee budget.');
        }
        return { kind, hash: transaction.getId(), rawTransaction: transaction.toHex(), confirmed: false, broadcastAttempted: false };
    }

    async broadcast(step: SwapStep): Promise<void> {
        const response = await fetch(`${config.destination.url}/tx`, {
            method: 'POST', headers: { 'content-type': 'text/plain' }, body: step.rawTransaction,
            signal: AbortSignal.timeout(config.httpTimeoutMs), redirect: 'error'
        });
        if (!response.ok) throw new SwapHttpError(response.status, `Bitcoin broadcast failed (HTTP ${response.status}).`);
        if (transactionHash((await response.text()).trim()) !== step.hash) throw new Error('Unexpected Bitcoin broadcast hash.');
    }

    async receipt(hash: string): Promise<ChainReceipt> {
        try {
            const tx = record(await swapJson(`${config.destination.url}/tx/${transactionHash(hash)}`));
            if (transactionHash(tx.txid) !== transactionHash(hash)) throw new Error('Bitcoin transaction hash mismatch.');
            const confirmations = await this.confirmations(record(tx.status));
            return { state: confirmations >= config.bitcoinConfirmations ? 'confirmed' : 'pending', confirmations };
        } catch (error) {
            if (error instanceof SwapHttpError && error.status === 404) return { state: 'not_found', confirmations: 0 };
            throw error;
        }
    }

    async payoutPayment(hash: string, address: string) { return new BscPayments().payment(hash, address); }
    async refundPayment(hash: string, address: string) { return this.payment(hash, address); }
}
