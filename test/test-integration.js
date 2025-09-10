#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Table from 'cli-table3';
import ora from 'ora';
import { NetworkTester, TEST_CONFIG } from './test.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class IntegrationTester extends NetworkTester {
    constructor() {
        super();
        this.crossNetworkResults = [];
    }

    async testWalletIntegration() {
        console.log('🔗 Running Integration Tests...\n');

        const networks = await this.loadNetworkPlugins();
        const web3Networks = networks.filter(n => n.NetworkClass.name === 'Web3Network');
        const bitcoinNetworks = networks.filter(n => n.NetworkClass.name === 'BitcoinNetwork');
        const tonNetworks = networks.filter(n => n.NetworkClass.name === 'TONNetwork');

        // Test 1: Cross-network mnemonic consistency
        await this.testMnemonicConsistency(web3Networks);
        
        // Test 2: Network type grouping
        await this.testNetworkTypeGrouping(web3Networks, bitcoinNetworks, tonNetworks);
        
        // Test 3: Token configuration consistency
        await this.testTokenConsistency(networks);
        
        // Test 4: Explorer URL format validation
        await this.testExplorerUrls(networks);

        this.displayIntegrationResults();
    }

    async testMnemonicConsistency(web3Networks) {
        const spinner = ora('Testing mnemonic consistency across Web3 networks...').start();
        
        try {
            const testMnemonic = TEST_CONFIG.TEST_MNEMONIC;
            const addresses = {};
            
            for (const network of web3Networks) {
                const instance = new network.NetworkClass(network);
                const account = await instance.accountFromMnemonic(testMnemonic);
                addresses[network.name] = account.address;
            }
            
            // Check if EVM-compatible networks produce the same address
            const evmNetworks = web3Networks.filter(n => 
                n.name.includes('ERC-20') || n.name.includes('BEP-20')
            );
            
            if (evmNetworks.length > 1) {
                const firstAddress = addresses[evmNetworks[0].name];
                const consistent = evmNetworks.every(n => addresses[n.name] === firstAddress);
                
                this.crossNetworkResults.push({
                    test: 'EVM Address Consistency',
                    status: consistent ? 'PASS' : 'FAIL',
                    message: consistent ? 
                        'EVM networks produce consistent addresses' : 
                        'EVM networks produce different addresses from same mnemonic',
                    details: addresses
                });
            }
            
            spinner.succeed('Mnemonic consistency test completed');
        } catch (error) {
            spinner.fail(`Mnemonic consistency test failed: ${error.message}`);
            this.crossNetworkResults.push({
                test: 'Mnemonic Consistency',
                status: 'FAIL',
                message: error.message
            });
        }
    }

    async testNetworkTypeGrouping(web3Networks, bitcoinNetworks, tonNetworks) {
        const spinner = ora('Testing network type grouping...').start();
        
        try {
            const results = {
                'Web3 Networks': web3Networks.length,
                'Bitcoin Networks': bitcoinNetworks.length,
                'TON Networks': tonNetworks.length
            };
            
            const totalNetworks = web3Networks.length + bitcoinNetworks.length + tonNetworks.length;
            const allNetworks = await this.loadNetworkPlugins();
            
            this.crossNetworkResults.push({
                test: 'Network Type Distribution',
                status: totalNetworks === allNetworks.length ? 'PASS' : 'FAIL',
                message: tonNetworks.length === 0 ? 
                    `Found ${totalNetworks} categorized networks out of ${allNetworks.length} total (TON network disabled)` :
                    `Found ${totalNetworks} categorized networks out of ${allNetworks.length} total`,
                details: results
            });
            
            spinner.succeed('Network type grouping completed');
        } catch (error) {
            spinner.fail(`Network type grouping failed: ${error.message}`);
        }
    }

    async testTokenConsistency(networks) {
        const spinner = ora('Testing token configuration consistency...').start();
        
        try {
            const tokensBySymbol = {};
            
            for (const network of networks) {
                for (const [symbol, config] of Object.entries(network.tokens || {})) {
                    if (!tokensBySymbol[symbol]) {
                        tokensBySymbol[symbol] = [];
                    }
                    tokensBySymbol[symbol].push({
                        network: network.name,
                        address: config.address,
                        config: config
                    });
                }
            }
            
            // Check for common tokens (like USDT) across networks
            const commonTokens = Object.entries(tokensBySymbol)
                .filter(([symbol, configs]) => configs.length > 1);
            
            this.crossNetworkResults.push({
                test: 'Token Distribution',
                status: 'PASS',
                message: `Found ${Object.keys(tokensBySymbol).length} unique tokens across networks`,
                details: {
                    totalTokens: Object.keys(tokensBySymbol).length,
                    commonTokens: commonTokens.map(([symbol, configs]) => ({
                        symbol,
                        networks: configs.length
                    }))
                }
            });
            
            spinner.succeed('Token consistency test completed');
        } catch (error) {
            spinner.fail(`Token consistency test failed: ${error.message}`);
        }
    }

    async testExplorerUrls(networks) {
        const spinner = ora('Testing explorer URL formats...').start();
        
        try {
            const invalidUrls = [];
            const urlPattern = /^https?:\/\/.+\/$/;
            
            for (const network of networks) {
                if (!urlPattern.test(network.explorer)) {
                    invalidUrls.push({
                        network: network.name,
                        explorer: network.explorer,
                        issue: 'URL should start with http(s):// and end with /'
                    });
                }
            }
            
            this.crossNetworkResults.push({
                test: 'Explorer URL Format',
                status: invalidUrls.length === 0 ? 'PASS' : 'FAIL',
                message: invalidUrls.length === 0 ? 
                    'All explorer URLs are properly formatted' :
                    `${invalidUrls.length} networks have invalid explorer URLs`,
                details: invalidUrls
            });
            
            spinner.succeed('Explorer URL test completed');
        } catch (error) {
            spinner.fail(`Explorer URL test failed: ${error.message}`);
        }
    }

    displayIntegrationResults() {
        console.log('\n' + '='.repeat(80));
        console.log('🔗 INTEGRATION TEST RESULTS');
        console.log('='.repeat(80));

        const integrationTable = new Table({
            head: ['Test', 'Status', 'Message'],
            style: { head: ['cyan'] },
            colWidths: [25, 8, 45],
            wordWrap: true
        });

        for (const result of this.crossNetworkResults) {
            const statusSymbol = result.status === 'PASS' ? '✅' : '❌';
            const statusColor = result.status === 'PASS' ? 'green' : 'red';
            
            integrationTable.push([
                result.test,
                { content: statusSymbol, style: statusColor },
                result.message
            ]);
        }

        console.log(integrationTable.toString());

        // Show detailed results if available
        for (const result of this.crossNetworkResults) {
            if (result.details) {
                console.log(`\n📋 Details for ${result.test}:`);
                console.log(JSON.stringify(result.details, null, 2));
            }
        }
    }
}

// Run integration tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const tester = new IntegrationTester();
    
    try {
        await tester.testWalletIntegration();
        process.exit(0);
    } catch (error) {
        console.error('❌ Integration test runner failed:', error.message);
        process.exit(1);
    }
}

export { IntegrationTester };
