# AGENTS.md

This file provides guidance to Agents when working with code in this repository.

## Project Overview

HODL Wallet is a CLI-based multi-network cryptocurrency wallet written in TypeScript for Node.js. It supports Bitcoin and EVM-compatible networks.

This repository is a pnpm workspace. The published package and CLI live in
`packages/hodl-wallet/`; the browser feasibility harness lives in `apps/web/`. Source paths
below are relative to `packages/hodl-wallet/`. Run the commands below from the
repository root. Workspace dependency policy and the shared lockfile stay at the root.

## Key Commands

- **Start the application**: `pnpm start` or `node packages/hodl-wallet/dist/index.js` after building
- **Install globally**: `npm install -g hodl-wallet` then run `hodl`
- **Build**: `pnpm run build` (TypeScript sources emit to `packages/hodl-wallet/dist/`; copies the root README into the package)
- **Typecheck**: `pnpm run typecheck`
- **Focused checks**: `pnpm run test:agent`, `pnpm run test:persist`, `pnpm run test:transfer`, `pnpm run test:swap`
- **Release checks**: `pnpm run prepublishOnly`
- **Package tarball**: `pnpm --filter hodl-wallet pack` after building; publish only the package, never the private workspace root

## Web Feasibility Harness

- `hodl-wallet/browser` exposes the shared networks, amounts, transfer/swap
  services and `WalletStore` contract without importing the CLI or persistence.
  Node keeps native crypto through `#environment`; the browser uses Web Crypto.
  Existing package entry points remain available without an exports map.
- `Persist` implements `WalletStore`. Reads must be detached; callers hold the
  wallet lock and `flush()` must finish durable writes before any broadcast.
- Browser compatibility adapters and the WASM loader live in
  `apps/web/vite.config.js`. Keep constructor names intact because account keys
  use them. Browser probes compare addresses, signatures and recovery with Node.
- `pnpm run build:web` builds the existing package and the static diagnostic in
  `apps/web/dist/`. This is not yet an operational browser wallet.
- `pnpm run preview:web` serves the built diagnostic locally.
- `pnpm run typecheck:web` checks browser TypeScript using the existing compiler.
- `pnpm run test:web` builds and runs offline Playwright checks in Chromium,
  Firefox and WebKit. Install browsers with `pnpm --filter @hodl/web exec playwright install`.
- `pnpm run test:web:connectivity` explicitly probes configured public endpoints
  from Chromium. It does not broadcast; reachable HTTP does not prove swap availability.
- Web tool dependencies belong to `apps/web/package.json`. Browser test policy
  is in `apps/web/config.mjs`; endpoints and HTTP timeouts come from `swap/config.ts`.
- `apps/web/.probe-build/`, `dist/` and `test-results/` are generated. The build
  rejects Node-only modules and the browser reports actual import/vector failures.

## Swap Module

- `swap/service.ts` coordinates encrypted quotes, idempotent funding and progress;
  both the interactive menu and JSON CLI use it under the profile lock.
- `swap/routes.ts` defines USDT on BSC ↔ native Bitcoin. `swap/providers.ts`
  adapts Chainflip deposit channels and THORChain deposits to each route.
  THORChain uses automatic streaming; Chainflip uses a single execution. No DCA
  or boosts. Quotes bind the original source sender as refund destination. Partial streaming results require verified
  BTC and USDT payouts before `partial_completed`; never report them as a full swap.
- `swap/chain.ts` handles BSC funding and payment verification; `swap/bitcoin.ts`
  handles Bitcoin funding, confirmed inputs, fees and extended THORChain memos.
  Both implement `SwapChain`; the coordinator shares persistence and settlement.
  `swap/storage.ts` reads existing forward-route operations without migration.
  `swap/config.ts` is the centralized source for swap endpoints, timeouts, gas
  budgets, price tolerance and confirmation counts; do not duplicate defaults.
- `swap/test/` uses Node's test runner, temporary encrypted wallets and
  mocked providers/RPCs. Never use a real wallet or send funds for verification.
- Quote availability is checked at runtime; documentation alone is not proof
  that a provider currently supports the BSC USDT route.

## Architecture Overview

### Core Components

- **index.ts**: Main application entry point containing the `Wallet` class and `UIManager` class
- **persist.ts**: Encrypted data persistence layer using Deepbase with AES encryption
- **transfer-service.ts**: Shared durable transfer journal and recovery used by the menu and JSON CLI; callers hold the profile lock
- **network/**: Network implementations following a plugin architecture

### Network Plugin System

The application uses a modular network plugin system:

- **BaseNetwork.ts**: Abstract base class defining the interface all networks must implement
- **Web3Network.ts**: EVM-compatible network implementation extending BaseNetwork
- **BitcoinNetwork.ts**: Bitcoin-specific network implementation

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

- Network implementations extend `Web3Network` or `BitcoinNetwork`
- All user interactions use the `inquirer` library for CLI prompts
- Tables displayed using `cli-table3` for consistent formatting
- Async/await pattern used throughout
- ES6 modules with `.js` extensions
