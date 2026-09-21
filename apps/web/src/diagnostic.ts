import './diagnostic.css';
import { NetworkRegistry } from 'hodl-wallet/browser';

type Probe = { id: string; state: string; bundled: boolean; detail?: string; expected?: unknown; nodeModules?: string[] };
type Endpoint = { id: string; url: string; method?: string; body?: unknown };
type Report = { results: Probe[]; endpoints: Endpoint[]; timeoutMs: number };

function row(parent: string, id: string, state: string, detail: string): void {
    const item = document.createElement('li');
    item.dataset.id = id;
    item.dataset.state = state;
    item.textContent = `${id} / ${state}: ${detail}`;
    document.querySelector(parent)!.append(item);
}

async function start(): Promise<void> {
    const response = await fetch('/compatibility.json');
    if (!response.ok) throw new Error(`Compatibility report: HTTP ${response.status}`);
    const report: Report = await response.json();
    for (const probe of report.results) {
        if (!probe.bundled) {
            row('#core', probe.id, 'blocked', [probe.detail, probe.nodeModules?.join(', ')].filter(Boolean).join(' · '));
            continue;
        }
        try {
            const module = await import(/* @vite-ignore */ `/probes/${probe.id}/probe.js`);
            const result = await module.run();
            if (JSON.stringify(result) !== JSON.stringify(probe.expected)) throw new Error('Browser/Node vector mismatch.');
            row('#core', probe.id, probe.state === 'blocked' ? 'blocked' : 'passed',
                probe.state === 'blocked' ? `Vector matches; Node imports awaiting review: ${probe.nodeModules?.join(', ')}` : 'Matches the Node result.');
        } catch (error) {
            row('#core', probe.id, probe.state === 'blocked' ? 'blocked' : 'failed',
                [(error as Error).message, probe.nodeModules?.join(', ')].filter(Boolean).join(' · '));
        }
    }
    try {
        crypto.getRandomValues(new Uint8Array(32));
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
        const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        if (hex !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') throw new Error('SHA-256 vector mismatch.');
        row('#core', 'webcrypto', 'passed', 'Randomness available and SHA-256 vector matches.');
    } catch (error) { row('#core', 'webcrypto', 'failed', (error as Error).message); }
    document.querySelector('#status')!.textContent = `Checks complete. Shared entry loaded: ${new NetworkRegistry().list().length} configured networks. The web vault is available on the home screen.`;
    const button = document.querySelector<HTMLButtonElement>('#connectivity')!;
    button.disabled = false;
    button.addEventListener('click', async () => {
        button.disabled = true;
        document.querySelector('#providers')!.replaceChildren();
        try {
            await Promise.all(report.endpoints.map(async endpoint => {
                try {
                    const response = await fetch(endpoint.url, {
                        method: endpoint.method ?? 'GET',
                        headers: endpoint.body ? { 'Content-Type': 'application/json' } : undefined,
                        body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
                        credentials: 'omit',
                        cache: 'no-store',
                        signal: AbortSignal.timeout(report.timeoutMs)
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const text = await response.text();
                    if (endpoint.id === 'bitcoin') {
                        if (!/^\d+$/.test(text.trim())) throw new Error('Invalid block height.');
                    } else {
                        const data = JSON.parse(text);
                        if (endpoint.id === 'bsc' && data.result !== '0x38') throw new Error('Unexpected BSC chain ID.');
                        if (endpoint.id === 'chainflip' && !Array.isArray(data.assets)) throw new Error('Invalid asset inventory.');
                        if (endpoint.id === 'thorchain' && !Array.isArray(data)) throw new Error('Invalid inbound addresses.');
                    }
                    row('#providers', endpoint.id, 'reachable', 'Public response readable; operations not yet verified.');
                } catch (error) {
                    row('#providers', endpoint.id, 'unavailable', `${(error as Error).message} (HTTP, network, CORS or timeout; check browser diagnostics).`);
                }
            }));
        } finally { button.disabled = false; }
    });
}

start().catch(error => { document.querySelector('#status')!.textContent = `Check failed: ${error.message}`; });
