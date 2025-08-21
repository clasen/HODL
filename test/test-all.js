#!/usr/bin/env node

import { NetworkTester } from './test.js';
import { IntegrationTester } from './test-integration.js';
import inquirer from 'inquirer';
import Table from 'cli-table3';

class ComprehensiveTester {
    constructor() {
        this.networkTester = new NetworkTester();
        this.integrationTester = new IntegrationTester();
    }

    displayWelcome() {
        console.log('\x1b[32m');  // Set text color to green
        console.log(`
 ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
 ░░░░░░░░░░░░░░ 🧊 HODL WALLET - COMPREHENSIVE TEST SUITE ░░░░░░░░░░░░░░
 ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
        `);
        console.log('\x1b[0m');  // Reset text color
        console.log('This test suite will validate all network implementations and integrations.\n');
    }

    async selectTestType() {
        const choices = [
            { name: 'Run All Tests (Recommended)', value: 'all' },
            { name: 'Network Tests Only', value: 'network' },
            { name: 'Integration Tests Only', value: 'integration' },
            { name: 'Quick Validation', value: 'quick' },
            { name: 'Exit', value: 'exit' }
        ];

        const { testType } = await inquirer.prompt({
            type: 'list',
            name: 'testType',
            message: 'What type of tests would you like to run?',
            choices
        });

        return testType;
    }

    async runQuickValidation() {
        console.log('⚡ Running Quick Validation...\n');
        
        const networks = await this.networkTester.loadNetworkPlugins();
        
        const quickTable = new Table({
            head: ['Network', 'File', 'Class', 'Config', 'Status'],
            style: { head: ['cyan'] },
            colWidths: [25, 12, 15, 10, 10]
        });

        for (const network of networks) {
            let status = '✅ OK';
            let configStatus = '✅';
            
            try {
                // Quick config check
                const required = ['name', 'NetworkClass', 'url', 'nativeToken', 'explorer'];
                const missing = required.filter(prop => !network[prop]);
                if (missing.length > 0) {
                    configStatus = '❌';
                    status = '❌ FAIL';
                }
                
                // Quick instantiation check
                new network.NetworkClass(network);
                
            } catch (error) {
                status = '❌ FAIL';
                configStatus = '❌';
            }
            
            quickTable.push([
                network.name,
                network.fileName,
                network.NetworkClass.name,
                configStatus,
                status
            ]);
        }

        console.log(quickTable.toString());
        console.log(`\n📊 Quick validation complete. Found ${networks.length} networks.`);
        
        return networks.every(network => {
            try {
                const required = ['name', 'NetworkClass', 'url', 'nativeToken', 'explorer'];
                const missing = required.filter(prop => !network[prop]);
                if (missing.length > 0) return false;
                new network.NetworkClass(network);
                return true;
            } catch {
                return false;
            }
        });
    }

    async runAllTests() {
        console.log('🚀 Running Comprehensive Test Suite...\n');
        
        // Step 1: Network Tests
        console.log('Step 1/2: Running Network Tests');
        console.log('-'.repeat(40));
        await this.networkTester.runAllTests();
        
        // Step 2: Integration Tests
        console.log('\nStep 2/2: Running Integration Tests');
        console.log('-'.repeat(40));
        await this.integrationTester.testWalletIntegration();
        
        // Combined summary
        this.displayCombinedSummary();
    }

    displayCombinedSummary() {
        console.log('\n' + '='.repeat(80));
        console.log('🎯 COMPREHENSIVE TEST SUMMARY');
        console.log('='.repeat(80));

        const summaryTable = new Table({
            head: ['Test Category', 'Passed', 'Failed', 'Total', 'Success Rate'],
            style: { head: ['cyan'] },
            colWidths: [20, 8, 8, 8, 12]
        });

        const networkResults = this.networkTester.results;
        const integrationResults = this.integrationTester.crossNetworkResults;
        
        const networkTotal = networkResults.passed + networkResults.failed;
        const networkSuccess = networkTotal > 0 ? ((networkResults.passed / networkTotal) * 100).toFixed(1) : '0';
        
        const integrationPassed = integrationResults.filter(r => r.status === 'PASS').length;
        const integrationFailed = integrationResults.filter(r => r.status === 'FAIL').length;
        const integrationTotal = integrationPassed + integrationFailed;
        const integrationSuccess = integrationTotal > 0 ? ((integrationPassed / integrationTotal) * 100).toFixed(1) : '0';

        summaryTable.push(
            ['Network Tests', networkResults.passed, networkResults.failed, networkTotal, `${networkSuccess}%`],
            ['Integration Tests', integrationPassed, integrationFailed, integrationTotal, `${integrationSuccess}%`]
        );

        console.log(summaryTable.toString());

        const overallPassed = networkResults.passed + integrationPassed;
        const overallFailed = networkResults.failed + integrationFailed;
        const overallTotal = overallPassed + overallFailed;
        const overallSuccess = overallTotal > 0 ? ((overallPassed / overallTotal) * 100).toFixed(1) : '0';

        console.log(`\n🎯 OVERALL RESULTS:`);
        console.log(`   Total Tests: ${overallTotal}`);
        console.log(`   Passed: ${overallPassed}`);
        console.log(`   Failed: ${overallFailed}`);
        console.log(`   Overall Success Rate: ${overallSuccess}%`);
        console.log('='.repeat(80));

        if (overallFailed === 0) {
            console.log('🎉 ALL TESTS PASSED! Your HODL wallet is fully functional!');
            console.log('   ✅ All networks are properly configured');
            console.log('   ✅ All network classes implement required methods');
            console.log('   ✅ Cross-network integration is working');
            console.log('   ✅ Ready for production use!');
        } else {
            console.log('⚠️  Some tests failed. Please review the issues above.');
            console.log('   💡 Check network configurations and implementations');
            console.log('   💡 Ensure all required dependencies are installed');
            console.log('   💡 Verify network connectivity if applicable');
        }
    }

    async run() {
        this.displayWelcome();
        
        while (true) {
            const testType = await this.selectTestType();
            
            switch (testType) {
                case 'all':
                    await this.runAllTests();
                    break;
                    
                case 'network':
                    await this.networkTester.runAllTests();
                    break;
                    
                case 'integration':
                    await this.integrationTester.testWalletIntegration();
                    break;
                    
                case 'quick':
                    const quickResult = await this.runQuickValidation();
                    if (quickResult) {
                        console.log('✅ Quick validation passed! All networks appear to be properly configured.');
                    } else {
                        console.log('❌ Quick validation failed! Some networks have configuration issues.');
                    }
                    break;
                    
                case 'exit':
                    console.log('👋 Thanks for testing your HODL wallet!');
                    return;
            }
            
            console.log('\n' + '-'.repeat(80) + '\n');
        }
    }
}

// Run comprehensive tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const tester = new ComprehensiveTester();
    
    try {
        await tester.run();
        process.exit(0);
    } catch (error) {
        console.error('❌ Test suite failed:', error.message);
        process.exit(1);
    }
}

export { ComprehensiveTester };
