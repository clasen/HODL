import { integer, record, textField } from './http.js';
import { swapRoute } from './routes.js';
import type { SwapOperation, SwapQuote } from './types.js';

export function readSwapQuote(value: unknown): SwapQuote {
    const stored = record(value);
    if (stored.routeId !== undefined) {
        swapRoute(textField(stored.routeId));
        return stored as SwapQuote;
    }
    const { expectedSats, minimumSats, gasPrice, gasUnits, gasBudgetWei, netAfterGasSats, ...quote } = stored;
    return {
        ...quote, routeId: 'bsc-btc',
        expectedBaseUnits: textField(expectedSats), minimumBaseUnits: textField(minimumSats),
        netOutputBaseUnits: textField(netAfterGasSats),
        funding: {
            asset: 'BNB', decimals: 18, price: 'bnb', rate: textField(gasPrice),
            units: integer(gasUnits), budgetBaseUnits: textField(gasBudgetWei)
        }
    } as SwapQuote;
}

export function readSwapOperation(value: unknown): SwapOperation {
    const { payoutSats, ...stored } = record(value);
    const quote = readSwapQuote(stored.quote);
    return {
        ...stored, quote,
        ...(payoutSats === undefined ? {} : { payoutBaseUnits: textField(payoutSats) })
    } as SwapOperation;
}
