import { formatUnits, parseDecimalToUnits } from 'hodl-wallet/dist/amounts.js';

export async function run() {
    const values = ['0.00000001', '1.23456789', '9007199254740993'];
    const roundTrips = values.map(value => formatUnits(parseDecimalToUnits(value, 8), 8));
    let rejected = false;
    try { parseDecimalToUnits('0.000000001', 8); }
    catch { rejected = true; }
    if (!rejected || values.some((value, index) => value !== roundTrips[index])) {
        throw new Error('Decimal precision was not preserved.');
    }
    return { roundTrips, excessPrecisionRejected: rejected };
}
