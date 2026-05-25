# 🧪 HODL Wallet Testing Guide

This document explains how to run comprehensive tests for the HODL Wallet library to verify that all networks function correctly.

## 📋 Overview

The HODL Wallet testing system includes three types of tests:

1. **Network Tests** - Validates each network individually
2. **Integration Tests** - Verifies consistency between networks
3. **Quick Validation** - Basic configuration check

## 🚀 How to Run Tests

### Method 1: Complete Suite (Recommended)
```bash
npm test
# or directly:
node test-all.js
```

### Method 2: Specific Tests
```bash
# Network tests only
npm run test:network

# Integration tests only
npm run test:integration

# Quick validation
npm run test:quick
```

### Method 3: Run individual files
```bash
# Complete network tests
node test/test.js

# Integration tests
node test/test-integration.js

# Complete suite with interactive menu
node test/test-all.js
```

## 🔍 What the Tests Cover

### Network Tests (test.js)

For each network found in `/network/`, these tests are executed:

#### ✅ Basic Configuration
- Verifies required properties: `name`, `NetworkClass`, `url`, `nativeToken`, `explorer`
- Validates that `tokens` is a valid object

#### ✅ Class Instantiation
- Confirms that the network class can be instantiated correctly
- Verifies there are no constructor errors

#### ✅ Required Methods
- Confirms that all mandatory methods are implemented:
  - `getBalance`, `transfer`, `transferToken`
  - `estimateGas`, `getGasPrice`
  - `privateKeyToAccount`, `createAccount`
  - `accountFromMnemonic`, `createAccountFromMnemonic`
  - `validateMnemonic`, `getTokenBalance`, `getTokenBalances`
  - `sendSignedTransaction`

#### ✅ Mnemonic Functionality
- Validates correct and incorrect mnemonics
- Tests account creation from mnemonic
- Verifies generation of new mnemonics

#### ✅ Account Creation
- Tests creation from private key (EVM)
- Tests new account creation
- Verifies accounts have address and privateKey

#### ✅ Network Connectivity
- Attempts to get gas price to verify connectivity
- Handles timeouts and network errors gracefully

### Integration Tests (test-integration.js)

#### ✅ Mnemonic Consistency
- Verifies EVM networks produce the same address for the same mnemonic
- Compares addresses between Ethereum, BSC, Arbitrum, etc.

#### ✅ Network Type Grouping
- Categorizes networks by type: Web3, Bitcoin, TON
- Verifies all networks are correctly categorized

#### ✅ Token Consistency
- Analyzes common tokens across networks (e.g., USDT)
- Verifies token configuration

#### ✅ Explorer URL Format
- Validates all explorer URLs have correct format
- Verifies they end with `/` for hash concatenation

## 📊 Interpreting Results

### Test States
- ✅ **PASS** - Test successful
- ❌ **FAIL** - Test failed
- ⚠️ **SKIP** - Test skipped

### Example Successful Output
```
🧊 HODL WALLET - NETWORK TEST RESULTS
================================================================================
┌──────────────────────────────┬───────────────┬────────┬────────┬──────────┐
│ Network                      │ File          │ Passed │ Failed │ Status   │
├──────────────────────────────┼───────────────┼────────┼────────┼──────────┤
│ [ERC-20] Ethereum            │ eth.js        │ 9      │ 0      │ ✅ PASS  │
│ [BEP-20] Binance Smart Chain │ bsc.js        │ 9      │ 0      │ ✅ PASS  │
│ [BTC] Bitcoin                │ btc.js        │ 8      │ 0      │ ✅ PASS  │
│ [TON] The Open Network       │ ton.js        │ 8      │ 0      │ ✅ PASS  │
└──────────────────────────────┴───────────────┴────────┴────────┴──────────┘

🎯 OVERALL SUMMARY:
   Total Tests: 79
   Passed: 79
   Failed: 0
   Success Rate: 100.0%
================================================================================
🎉 All tests passed! Your HODL wallet is ready to go!
```

## 🛠️ Troubleshooting

### Error: "No network plugins found"
- Verify compiled `.js` files exist in the `/dist/network/` directory after `pnpm run build`
- Confirm files export a valid default object

### Error: "Missing required properties"
- Check each network has: `name`, `NetworkClass`, `url`, `nativeToken`, `explorer`
- Verify `tokens` is defined (can be empty object `{}`)

### Error: "Method 'X' must be implemented"
- Network class doesn't implement all required methods
- Check it properly inherits from `BaseNetwork`

### Error: "Network unreachable"
- Normal for tests without internet connection
- Doesn't cause test failure, only reported

### Error: "Mnemonic validation failed"
- Verify `validateMnemonic` implementation uses standard libraries
- Confirm it accepts valid 12-word mnemonics

## 🔧 Test Configuration

### Test Data (DO NOT USE IN PRODUCTION)
```javascript
// Standard test mnemonic
TEST_MNEMONIC: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// Test private key
TEST_PRIVATE_KEY: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
```

### Environment Variables
Tests don't require special environment variables, but you can configure:
- `NODE_ENV=test` for test mode
- Custom timeouts in code

## 📝 Adding New Tests

To add tests for a new network:

1. Create network file in `/network/new-network.ts`
2. Ensure it exports object with correct structure
3. Tests will run automatically

To add new test types:

1. Modify `test.js` for individual network tests
2. Modify `test-integration.js` for cross-network tests
3. Update `test-all.js` if you need new menu options

## 🎯 Best Practices

1. **Run all tests** before important commits
2. **Review details** of failed tests to understand issues
3. **Use quick validation** during development for immediate feedback
4. **Test connectivity** periodically to verify RPC URLs
5. **Maintain consistency** in token configuration across similar networks

## 🚨 Security Notes

- ❌ **NEVER** use test private keys or mnemonics in production
- ❌ **NEVER** hardcode real keys in tests
- ✅ **ALWAYS** use public, known test data
- ✅ **ALWAYS** clearly document what data is test-only

---

Happy Testing! 🧪✨
