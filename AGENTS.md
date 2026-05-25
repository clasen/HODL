# AGENTS.md

This file provides guidance to Agents when working with code in this repository.

## Project Overview

HODL Wallet is a CLI-based multi-network cryptocurrency wallet written in Node.js. It supports Bitcoin, TON (The Open Network), and multiple EVM-compatible networks (Ethereum, BSC, Polygon, Arbitrum, Optimism, Fantom, Avalanche).

## Key Commands

- **Start the application**: `npm start` or `node index.js`
- **Install globally**: `npm install -g hodl-wallet` then run `hodl`
- **No test suite configured**: The project uses `echo "Error: no test specified" && exit 1` for tests

## Architecture Overview

### Core Components

- **index.js**: Main application entry point containing the `Wallet` class and `UIManager` class
- **persist.js**: Encrypted data persistence layer using Deepbase with AES encryption
- **network/**: Network implementations following a plugin architecture

### Network Plugin System

The application uses a modular network plugin system:

- **BaseNetwork.js**: Abstract base class defining the interface all networks must implement
- **Web3Network.js**: EVM-compatible network implementation extending BaseNetwork
- **BitcoinNetwork.js**: Bitcoin-specific network implementation
- **TONNetwork.js**: TON network implementation

Each network plugin exports:
- `NetworkClass`: The implementation class
- `name`: Display name for the network
- `url`: RPC endpoint URL
- `nativeToken`: Native token symbol (e.g., 'ETH', 'BTC')
- `explorer`: Block explorer URL template
- `tokens`: Object mapping token symbols to contract addresses

### Data Storage

- User data stored in `~/.HODL/` directory
- All data encrypted using user-provided password
- Supports mnemonic phrases, private keys, address book, and transaction history
- Network usage tracking for auto-selection of last-used network

### Key Features

- Multi-network wallet with unified interface
- Encrypted local storage with password protection
- Address book with autocomplete
- Transaction history tracking
- HODL file export/import for wallet backup
- Mnemonic and private key import/export

### Security Considerations

- Private keys and mnemonics are encrypted at rest
- Password required for all operations
- Support for offline account creation
- Transparent open-source codebase encourages security audits

## Common Development Patterns

- Network implementations extend either `Web3Network`, `BitcoinNetwork`, or `BaseNetwork` (for TON)
- All user interactions use the `inquirer` library for CLI prompts
- Tables displayed using `cli-table3` for consistent formatting
- Async/await pattern used throughout
- ES6 modules with `.js` extensions

## TON Network Integration

The TON network has been integrated with the following features:
- Native TON balance checking
- TON transfers using WalletContractV4
- Mnemonic phrase support (TON uses 24-word mnemonics)
- Integration with @ton/ton, @ton/crypto, and @ton/core libraries
- Fallback RPC endpoint if @orbs-network/ton-access is unavailable

**TON Features:**
- Native TON balance checking and transfers ✅
- Jetton (token) balance checking ✅
- Jetton transfers ✅
- Uses standard jetton master contract methods
- Supports TEP-74 jetton standard

**TON Limitations:**
- Private key import not supported (use mnemonic instead)
- Gas estimation uses fixed approximation
- Jetton decimals assumed to be 9 (standard for most tokens)