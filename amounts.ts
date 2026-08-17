const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export function parseDecimalToUnits(amount: string, decimals: number): bigint {
    if (!Number.isInteger(decimals) || decimals < 0) {
        throw new TypeError('Decimals must be a non-negative integer.');
    }

    const match = DECIMAL_PATTERN.exec(amount);
    if (!match) {
        throw new TypeError('Amount must be a plain positive decimal string.');
    }

    const fraction = match[2] || '';
    if (fraction.length > decimals) {
        throw new TypeError(`Amount supports at most ${decimals} decimal places.`);
    }

    const wholeUnits = BigInt(match[1]) * (10n ** BigInt(decimals));
    const fractionalUnits = fraction
        ? BigInt(fraction.padEnd(decimals, '0'))
        : 0n;
    const units = wholeUnits + fractionalUnits;

    if (units <= 0n) {
        throw new TypeError('Amount must be greater than zero.');
    }

    return units;
}

export function formatUnits(units: bigint | string, decimals: number): string {
    if (!Number.isInteger(decimals) || decimals < 0) {
        throw new TypeError('Decimals must be a non-negative integer.');
    }

    const value = typeof units === 'bigint' ? units : BigInt(units);
    const negative = value < 0n;
    const absolute = negative ? -value : value;

    if (decimals === 0) {
        return `${negative ? '-' : ''}${absolute}`;
    }

    const padded = absolute.toString().padStart(decimals + 1, '0');
    const whole = padded.slice(0, -decimals);
    const fraction = padded.slice(-decimals).replace(/0+$/, '');

    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function normalizeDecimal(amount: string): string {
    const match = DECIMAL_PATTERN.exec(amount);
    if (!match) {
        throw new TypeError('Amount must be a plain positive decimal string.');
    }

    const fraction = (match[2] || '').replace(/0+$/, '');
    const normalized = fraction ? `${match[1]}.${fraction}` : match[1];
    if (BigInt(match[1]) === 0n && !/[1-9]/.test(fraction)) {
        throw new TypeError('Amount must be greater than zero.');
    }

    return normalized;
}
