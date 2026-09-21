import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { NetworkRegistry } from 'hodl-wallet/dist/network-registry.js';

const require = createRequire(import.meta.url);
const polyfills = {
    assert: require.resolve('assert/'),
    buffer: require.resolve('buffer/'),
    crypto: fileURLToPath(new URL('./compat/crypto.js', import.meta.url)),
    events: require.resolve('events/'),
    stream: require.resolve('stream-browserify'),
    string_decoder: require.resolve('string_decoder/'),
    util: require.resolve('util/'),
    process: require.resolve('process/browser.js')
};
const inject = { Buffer: [polyfills.buffer, 'Buffer'], process: polyfills.process };

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
            name: 'wallet-network-content-policy',
            transformIndexHtml(html) {
                const origins = [...new Set(new NetworkRegistry().list().map(network => new URL(network.url).origin))];
                return html.replace("connect-src 'self';", `connect-src 'self' ${origins.join(' ')};`);
            }
        },
        {
            name: 'preserve-secp256k1-wasm-globals',
            enforce: 'pre',
            load(id) {
                if (!id.endsWith('/tiny-secp256k1/lib/wasm_loader.browser.js')) return;
                // tiny-secp256k1 reads WebAssembly.Global.value; ESM WASM imports unwrap globals.
                return `import init from './secp256k1.wasm?init';
                    import * as rand from './rand.browser.js';
                    import * as validateError from './validate_error.js';
                    const instance = await init({ './rand.js': rand, './validate_error.js': validateError });
                    export default instance.exports;`;
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
