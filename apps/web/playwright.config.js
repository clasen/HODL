import { defineConfig, devices } from '@playwright/test';
import { webConfig } from './config.mjs';

export default defineConfig({
    testDir: './tests',
    timeout: webConfig.testTimeoutMs,
    use: { baseURL: `http://127.0.0.1:${webConfig.previewPort}` },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } }
    ],
    webServer: {
        command: `pnpm run preview --port ${webConfig.previewPort} --strictPort`,
        url: `http://127.0.0.1:${webConfig.previewPort}`,
        timeout: webConfig.serverTimeoutMs,
        reuseExistingServer: false
    }
});
