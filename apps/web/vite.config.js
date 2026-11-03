import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import { NetworkRegistry } from 'hodl-wallet/dist/network-registry.js';
import { swapConfig } from 'hodl-wallet/dist/swap/config.js';

const require = createRequire(import.meta.url);
const polyfills = {
    buffer: require.resolve('buffer/')
};
const inject = { Buffer: [polyfills.buffer, 'Buffer'] };

export default defineConfig({
    // Account storage keys use network constructor names.
    build: { minify: false, rolldownOptions: { transform: { inject } } },
    define: { global: 'globalThis' },
    optimizeDeps: { rolldownOptions: { transform: { inject } } },
    resolve: {
        alias: Object.entries(polyfills).map(([name, replacement]) => ({
            find: new RegExp(`^(?:node:)?${name}/?$`),
            replacement
        }))
    },
    plugins: [
        {
            name: 'wallet-content-policy',
            transformIndexHtml(html) {
                const networks = new NetworkRegistry().list().flatMap(network => [network.url, network.history?.url].filter(Boolean));
                const swaps = [swapConfig.chainflip.url, swapConfig.thorchain.url, swapConfig.thorchain.midgardUrl, swapConfig.nearIntents.url, swapConfig.pricesUrl];
                const origins = [...new Set([...networks, ...swaps].map(url => new URL(url).origin))];
                return html.replace("connect-src 'self';", `connect-src 'self' ${origins.join(' ')};`);
            }
        },
        {
            name: 'require-browser-only-graph',
            moduleParsed({ id }) {
                if (id.includes('browser-external') || /\/hodl-wallet\/dist\/(persist|wallet-service|profile-lock|environment-node|index)\.js$/.test(id)) {
                    throw new Error(`Browser graph includes a Node-only module: ${id}`);
                }
            }
        }
    ]
});
