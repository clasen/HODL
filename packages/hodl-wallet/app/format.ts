export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function formatAmount(num: number | string): string {
    num = parseFloat(num.toString());

    // Integers get .00
    if (num === Math.floor(num)) {
        return num.toString() + '.00';
    }

    // Decimals: at most 3 places, trailing zeros removed, at least 2 kept
    let formatted = num.toFixed(3);

    while (formatted.endsWith('0') && formatted.split('.')[1].length > 2) {
        formatted = formatted.slice(0, -1);
    }

    return formatted;
}

export function formatDate(date: string | number | Date): string {
    return new Date(date).toLocaleString('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1').replace(",", "");
}
