/** A request that got no HTTP response: the host was unreachable, refused it, or did not answer in time. */
export class NetworkError extends Error {}

/** fetch, naming the host when no response arrives; fetch reports that as a bare TypeError. */
export async function request(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    try {
        return await fetch(input, init);
    } catch (error) {
        const host = new URL(input instanceof Request ? input.url : input).host;
        if (error instanceof Error && error.name === 'TimeoutError') throw new NetworkError(`${host} did not respond in time.`, { cause: error });
        if (error instanceof TypeError) throw new NetworkError(`Could not reach ${host}.`, { cause: error });
        throw error;
    }
}

/** What to show for an error: a network failure among its causes outranks the wrappers that describe the request. */
export function errorMessage(error: unknown): string {
    for (let cause = error; cause instanceof Error; cause = cause.cause) {
        if (cause instanceof NetworkError) return cause.message;
    }
    return error instanceof Error ? error.message : String(error);
}
