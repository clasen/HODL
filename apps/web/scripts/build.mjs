import { mkdir, readFile, rm, cp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { swapConfig } from 'hodl-wallet/dist/swap/config.js';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const probes = ['amounts', 'evm', 'bitcoin', 'transfer', 'swap', 'wallet'];
const results = [];
await rm('.probe-build', { recursive: true, force: true });
for (const id of probes) {
    let bundled = false;
    try {
        await build({
            logLevel: 'silent',
            build: {
                outDir: `.probe-build/${id}`,
                lib: { entry: `probes/${id}.js`, formats: ['es'], fileName: () => 'probe.js' },
                minify: false
            }
        });
        bundled = true;
        const { run } = await import(`../probes/${id}.js`);
        const expected = await run();
        results.push({ id, state: 'built', bundled, expected });
    } catch (error) {
        results.push({ id, state: 'blocked', bundled, detail: error.message });
    }
}

await build({ logLevel: 'warn', build: { rolldownOptions: { input: { wallet: 'index.html', diagnostic: 'diagnostic.html' } } } });
await mkdir('dist/probes', { recursive: true });
for (const result of results.filter(result => result.bundled)) {
    await cp(`.probe-build/${result.id}`, `dist/probes/${result.id}`, { recursive: true });
}
const endpoints = [
    { id: 'bsc', url: swapConfig.source.url, method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] } },
    { id: 'bitcoin', url: `${swapConfig.destination.url}/blocks/tip/height` },
    { id: 'chainflip', url: `${swapConfig.chainflip.url}/api/networkInfo` },
    { id: 'thorchain', url: `${swapConfig.thorchain.url}/thorchain/inbound_addresses` },
    { id: 'midgard', url: `${swapConfig.thorchain.midgardUrl}/v2/health` },
    { id: 'prices', url: swapConfig.pricesUrl }
];
await writeFile('dist/compatibility.json', JSON.stringify({ results, endpoints, timeoutMs: swapConfig.httpTimeoutMs }, null, 2));
const { version } = JSON.parse(await readFile('node_modules/hodl-wallet/package.json', 'utf8'));
console.log(`hodl-wallet ${version}: ${results.filter(result => result.state === 'built').length}/${results.length} probes without detected Node dependencies.`);
for (const result of results) console.log(`${result.id}: ${result.state}${result.detail ? ` — ${result.detail}` : ''}`);
if (results.some(result => result.state !== 'built')) throw new Error('Browser compatibility build failed.');
