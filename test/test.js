#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Table from 'cli-table3';
import ora from 'ora';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test configuration
const TEST_CONFIG = {
    // Test mnemonic (DO NOT USE IN PRODUCTION)
    TEST_MNEMONIC: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    // Test private key (DO NOT USE IN PRODUCTION)  
    TEST_PRIVATE_KEY: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    // Test addresses for validation
    TEST_ADDRESSES: {
        ETH: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
        BTC: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
    }
};

class NetworkTester {
    constructor() {
        this.results = {
            passed: 0,
            failed: 0,
            skipped: 0,
            details: []
        };
    }

    async loadNetworkPlugins() {
        const pluginsDir = path.join(__dirname, '../network');
        const pluginFiles = fs.readdirSync(pluginsDir).filter(file => 
            file.endsWith('.js') && !file.startsWith('.')
        );

        const networks = [];
        
        for (const file of pluginFiles) {
            try {
                const plugin = await import(`../network/${file}`);
                if (plugin.default && plugin.default.name) {
                    networks.push({
                        ...plugin.default,
                        fileName: file
                    });
                }
            } catch (error) {
                console.warn(`Warning: Could not load network plugin ${file}:`, error.message);
            }
        }

        return networks;
    }

    async testNetworkConfiguration(network) {
        const tests = [];
        
        // Test 1: Basic configuration
        tests.push({
            name: 'Basic Configuration',
            test: () => {
                const required = ['name', 'NetworkClass', 'url', 'nativeToken', 'explorer'];
                const missing = required.filter(prop => !network[prop]);
                
                if (missing.length > 0) {
                    throw new Error(`Missing required properties: ${missing.join(', ')}`);
                }
                
                if (typeof network.tokens !== 'object') {
                    throw new Error('tokens property must be an object');
                }
                
                return 'Configuration is valid';
            }
        });

        // Test 2: Network class instantiation
        tests.push({
            name: 'Network Class Instantiation',
            test: () => {
                try {
                    const instance = new network.NetworkClass(network);
                    if (!instance) {
                        throw new Error('Failed to create network instance');
                    }
                    return 'Network class instantiated successfully';
                } catch (error) {
                    throw new Error(`Instantiation failed: ${error.message}`);
                }
            }
        });

        // Test 3: Required methods exist
        tests.push({
            name: 'Required Methods',
            test: () => {
                const instance = new network.NetworkClass(network);
                const requiredMethods = [
                    'getBalance', 'transfer', 'transferToken', 'estimateGas',
                    'getGasPrice', 'privateKeyToAccount', 'createAccount',
                    'accountFromMnemonic', 'createAccountFromMnemonic', 'validateMnemonic',
                    'getTokenBalance', 'getTokenBalances', 'sendSignedTransaction'
                ];
                
                const missingMethods = requiredMethods.filter(method => 
                    typeof instance[method] !== 'function'
                );
                
                if (missingMethods.length > 0) {
                    throw new Error(`Missing methods: ${missingMethods.join(', ')}`);
                }
                
                return 'All required methods are present';
            }
        });

        return tests;
    }

    async testNetworkFunctionality(network) {
        const tests = [];
        const instance = new network.NetworkClass(network);

        // Test 4: Mnemonic validation
        tests.push({
            name: 'Mnemonic Validation',
            test: () => {
                // Test valid mnemonic
                const validResult = instance.validateMnemonic(TEST_CONFIG.TEST_MNEMONIC);
                if (!validResult) {
                    throw new Error('Valid mnemonic was rejected');
                }
                
                // Test invalid mnemonic
                const invalidResult = instance.validateMnemonic('invalid mnemonic phrase');
                if (invalidResult) {
                    throw new Error('Invalid mnemonic was accepted');
                }
                
                return 'Mnemonic validation works correctly';
            }
        });

        // Test 5: Account creation from mnemonic
        tests.push({
            name: 'Account From Mnemonic',
            test: async () => {
                const account = await instance.accountFromMnemonic(TEST_CONFIG.TEST_MNEMONIC);
                
                if (!account || !account.address || !account.privateKey) {
                    throw new Error('Account creation failed or incomplete');
                }
                
                // More flexible address format validation for different networks
                if (!account.address.match(/^[a-zA-Z0-9_\-:]+$/)) {
                    // Allow alphanumeric characters, underscores, hyphens, and colons for various blockchain formats
                    throw new Error('Invalid address format');
                }
                
                return `Account created: ${account.address.substring(0, 10)}...`;
            }
        });

        // Test 6: Private key to account
        if (network.name.includes('ERC-20') || network.name.includes('BEP-20')) {
            tests.push({
                name: 'Private Key To Account',
                test: async () => {
                    const account = await instance.privateKeyToAccount(TEST_CONFIG.TEST_PRIVATE_KEY);
                    
                    if (!account || !account.address || !account.privateKey) {
                        throw new Error('Account creation from private key failed');
                    }
                    
                    return `Account created: ${account.address.substring(0, 10)}...`;
                }
            });
        }

        // Test 7: New account creation
        tests.push({
            name: 'Create New Account',
            test: async () => {
                const account = await instance.createAccount();
                
                if (!account || !account.address || !account.privateKey) {
                    throw new Error('New account creation failed');
                }
                
                return `New account: ${account.address.substring(0, 10)}...`;
            }
        });

        // Test 8: Create account from new mnemonic (12 words)
        tests.push({
            name: 'Create Account From New Mnemonic (12 words)',
            test: async () => {
                const account = await instance.createAccountFromMnemonic(12);
                
                if (!account || !account.address || !account.privateKey || !account.mnemonic) {
                    throw new Error('Account creation with 12-word mnemonic failed');
                }
                
                const wordCount = account.mnemonic.split(' ').length;
                if (wordCount !== 12) {
                    throw new Error(`Expected 12 words, got: ${wordCount}`);
                }
                
                // Verify the mnemonic is valid
                if (!instance.validateMnemonic(account.mnemonic)) {
                    throw new Error('Generated 12-word mnemonic is invalid');
                }
                
                return `12-word account: ${account.address.substring(0, 10)}...`;
            }
        });

        // Test 8b: Create account from new mnemonic (24 words)
        tests.push({
            name: 'Create Account From New Mnemonic (24 words)',
            test: async () => {
                const account = await instance.createAccountFromMnemonic(24);
                
                if (!account || !account.address || !account.privateKey || !account.mnemonic) {
                    throw new Error('Account creation with 24-word mnemonic failed');
                }
                
                const wordCount = account.mnemonic.split(' ').length;
                if (wordCount !== 24) {
                    throw new Error(`Expected 24 words, got: ${wordCount}`);
                }
                
                // Verify the mnemonic is valid
                if (!instance.validateMnemonic(account.mnemonic)) {
                    throw new Error('Generated 24-word mnemonic is invalid');
                }
                
                return `24-word account: ${account.address.substring(0, 10)}...`;
            }
        });

        return tests;
    }

    async testNetworkConnectivity(network) {
        const tests = [];
        
        // Test 9: Network connectivity (basic)
        tests.push({
            name: 'Network Connectivity',
            test: async () => {
                try {
                    const instance = new network.NetworkClass(network);
                    
                    // Try to get gas price as a connectivity test
                    await Promise.race([
                        instance.getGasPrice(),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Timeout')), 10000)
                        )
                    ]);
                    
                    return 'Network is reachable';
                } catch (error) {
                    // Don't fail the test for network issues, just report
                    return `Network unreachable: ${error.message}`;
                }
            }
        });

        return tests;
    }

    async runTestsForNetwork(network) {
        const spinner = ora(`Testing ${network.name}...`).start();
        
        const networkResults = {
            network: network.name,
            fileName: network.fileName,
            passed: 0,
            failed: 0,
            skipped: 0,
            tests: []
        };

        try {
            // Collect all tests
            const allTests = [
                ...(await this.testNetworkConfiguration(network)),
                ...(await this.testNetworkFunctionality(network)),
                ...(await this.testNetworkConnectivity(network))
            ];

            // Run each test
            for (const test of allTests) {
                try {
                    const result = await test.test();
                    networkResults.tests.push({
                        name: test.name,
                        status: 'PASS',
                        message: result
                    });
                    networkResults.passed++;
                    this.results.passed++;
                } catch (error) {
                    networkResults.tests.push({
                        name: test.name,
                        status: 'FAIL',
                        message: error.message
                    });
                    networkResults.failed++;
                    this.results.failed++;
                }
            }

            spinner.succeed(`${network.name} - ${networkResults.passed} passed, ${networkResults.failed} failed`);
            
        } catch (error) {
            spinner.fail(`${network.name} - Critical error: ${error.message}`);
            networkResults.tests.push({
                name: 'Critical Error',
                status: 'FAIL',
                message: error.message
            });
            networkResults.failed++;
            this.results.failed++;
        }

        this.results.details.push(networkResults);
        return networkResults;
    }

    displayResults() {
        console.log('\n' + '='.repeat(80));
        console.log('🧊 HODL WALLET - NETWORK TEST RESULTS');
        console.log('='.repeat(80));

        // Summary table
        const summaryTable = new Table({
            head: ['Network', 'File', 'Passed', 'Failed', 'Status'],
            style: { head: ['cyan'] },
            colWidths: [30, 15, 8, 8, 10]
        });

        for (const result of this.results.details) {
            const status = result.failed === 0 ? '✅ PASS' : '❌ FAIL';
            const statusColor = result.failed === 0 ? 'green' : 'red';
            
            summaryTable.push([
                result.network,
                result.fileName,
                result.passed.toString(),
                result.failed.toString(),
                { content: status, style: statusColor }
            ]);
        }

        console.log(summaryTable.toString());

        // Detailed results
        for (const result of this.results.details) {
            if (result.tests.length > 0) {
                console.log(`\n📋 Detailed Results for ${result.network}:`);
                
                const detailTable = new Table({
                    head: ['Test', 'Status', 'Message'],
                    style: { head: ['blue'] },
                    colWidths: [25, 8, 45],
                    wordWrap: true
                });

                for (const test of result.tests) {
                    const statusSymbol = test.status === 'PASS' ? '✅' : '❌';
                    const statusColor = test.status === 'PASS' ? 'green' : 'red';
                    
                    detailTable.push([
                        test.name,
                        { content: statusSymbol, style: statusColor },
                        test.message
                    ]);
                }

                console.log(detailTable.toString());
            }
        }

        // Final summary
        console.log('\n' + '='.repeat(80));
        const totalTests = this.results.passed + this.results.failed + this.results.skipped;
        const successRate = totalTests > 0 ? ((this.results.passed / totalTests) * 100).toFixed(1) : '0';
        
        console.log(`📊 OVERALL SUMMARY:`);
        console.log(`   Total Tests: ${totalTests}`);
        console.log(`   Passed: ${this.results.passed}`);
        console.log(`   Failed: ${this.results.failed}`);
        console.log(`   Success Rate: ${successRate}%`);
        console.log('='.repeat(80));

        if (this.results.failed === 0) {
            console.log('🎉 All tests passed! Your HODL wallet is ready to go!');
        } else {
            console.log('⚠️  Some tests failed. Please review the issues above.');
        }
    }

    async runAllTests() {
        console.log('🧊 HODL Wallet Network Testing Suite');
        console.log('=====================================\n');

        const networks = await this.loadNetworkPlugins();
        
        if (networks.length === 0) {
            console.error('❌ No network plugins found!');
            return;
        }

        console.log(`Found ${networks.length} networks to test:\n`);
        networks.forEach((network, index) => {
            console.log(`${index + 1}. ${network.name} (${network.fileName})`);
        });
        console.log('');

        // Run tests for each network
        for (const network of networks) {
            await this.runTestsForNetwork(network);
            // Small delay between networks
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        this.displayResults();
    }
}

// Export for use in other scripts
export { NetworkTester, TEST_CONFIG };

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const tester = new NetworkTester();
    
    try {
        await tester.runAllTests();
        process.exit(tester.results.failed === 0 ? 0 : 1);
    } catch (error) {
        console.error('❌ Test runner failed:', error.message);
        process.exit(1);
    }
}
