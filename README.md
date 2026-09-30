# 🧊 HODL Wallet - Fast CLI crypto wallet!

#### 📦 Install and try!
```bash
npm i -g hodl-wallet && hodl
```

![HODL Wallet](https://raw.githubusercontent.com/clasen/HODL/refs/heads/master/example.jpg)

## Development

The repository uses pnpm workspaces. The npm package and CLI live in
`packages/hodl-wallet/`; `apps/*` is reserved for future applications.
Run `pnpm install`, `pnpm run build`, `pnpm run typecheck`, and
`pnpm run prepublishOnly` from the repository root. Start the CLI with `pnpm start`.
To create a package tarball after building, run `pnpm --filter hodl-wallet pack`.
The root README is the source of truth and is copied into the package during build.

## 🚀 Why HODL Wallet?

Let's face it, Trust Wallet's sluggishness and annoying ads are so last season. HODL Wallet is here to agilize your crypto experience.

- 🏎️ Lightning-fast operations
- 🖥️ Interactive TUI and direct CLI commands
- 🤖 Agent-ready, non-interactive JSON interface
- 🚫 Zero ads, zero BS
- 🔒 Create wallets offline (because paranoia is just good sense in crypto)
- 🔍 Fully transparent, open-source code
- 🌐 Support for Bitcoin and Ethereum. BNB Smart Chain (BSC), Polygon, Avalanche, Optimism, Arbitrum, Fantom, and Hyperliquid.

That's it! Follow the prompts and you're in crypto heaven.

## 🎮 Features

### 💰 Create a Wallet

Pro tip: Do this offline if you're feeling extra cautious. We won't judge.

### 💸 Send Funds

Smoother than sliding into your crush's DMs.

### 👀 Check Balance

Because constantly checking your balance is totally healthy.

### 📘 Address Book

Keep your favorite addresses handy. No more copy-pasting!

### 🌐 Multi-Network Support

Seamlessly manage your assets on multiple networks. HODL Wallet supports the following networks:

- Bitcoin
- EVM
  - Ethereum
  - BNB Smart Chain (BSC)
  - Polygon
  - Optimism
  - Arbitrum One
  - Fantom
  - Avalanche C-Chain
  - Hyperliquid

Each network supports its native token and popular tokens like USDT. You can easily add more tokens as needed.

## 💾 Export and Import HODL Files

HODL Wallet now supports exporting and importing encrypted .HODL files, which securely store your wallet information.

- **Export HODL File**: Save your wallet data (including private keys and addresses) to an encrypted .HODL file.
- **Import HODL File**: Restore your wallet from a previously exported .HODL file.

These files are encrypted using your wallet password, providing an additional layer of security for storing and transferring your wallet information. Files saved in the legacy format by older releases can no longer be imported.

The main advantage of exporting a HODL file is that to access the private key, you need BOTH the file AND the password. This two-factor approach significantly enhances security. However, keep in mind that this solution is only compatible with HODL Wallet.

## Agent-friendly JSON CLI

Running `hodl` without arguments keeps the interactive wallet. Subcommands are
non-interactive: they emit one JSON object, use stable network IDs, and never
accept passwords, mnemonics, or private keys as command-line arguments.
Protected commands receive the password as JSON through stdin:

```bash
hodl networks
hodl wallet list

echo '{"password":"vault-password"}' |
  hodl wallet create --wallet treasury --words 24

echo '{"password":"vault-password"}' |
  hodl balance --wallet treasury --network eth

echo '{"password":"vault-password"}' |
  hodl send --wallet treasury --network eth \
    --to "$RECIPIENT_ADDRESS" \
    --asset ETH --amount 0.01 --dry-run

echo '{"password":"vault-password"}' |
  hodl send --wallet treasury --network eth \
    --to "$RECIPIENT_ADDRESS" \
    --asset ETH --amount 0.01 --yes --request-id payment-001
```

Successful commands write an envelope such as
`{"version":1,"ok":true,"command":"balance","data":{...}}` to stdout.
Failures write the equivalent `ok:false` envelope to stderr and return a
non-zero exit code. Amounts, balances, fees, and base units are JSON strings so
large values and token decimals remain exact.

Named profiles live under `~/.HODL/profiles/`. The special profile `default`
continues to use the existing `~/.HODL/persist.json` vault. A real transfer
requires both `--yes` and a unique `--request-id`; retries reuse the previously
prepared signed transaction instead of creating a second payment.

### Swap between USDT on BSC and native Bitcoin

The Swap menu appears on BSC and Bitcoin and shows the direction explicitly:
**USDT (BSC) → BTC (Bitcoin)** or **BTC (Bitcoin) → USDT (BSC)**.
**Track Swaps** is inside that menu and follows both directions regardless of the
selected network. Tracking only reads status and never signs or submits a
transaction. The destination account is offered by default; you can also type
an external address for the destination network. Importing only an EVM private
key does not create a Bitcoin account.

HODL compares single-execution Chainflip with automatic THORChain streaming,
which divides the exchange into smaller swaps to reduce price impact. Unavailable,
paused, or unsupported routes are shown separately. DCA, boosts and HODL affiliate
commissions are not enabled. Streaming and its estimated duration are shown
before confirmation. The best available quote is ranked by estimated destination value after accounting for the separate source-network fee: BNB for BSC, or BTC for Bitcoin.
Total cost includes fees and price impact against a recent CoinGecko reference;
it is an estimate, not a guaranteed execution price. There is no fixed cost cap:
review and accept the displayed cost before executing.

```bash
hodl swap destination --wallet treasury < "$WALLET_SECRET_INPUT"
hodl swap quote --wallet treasury --amount 100 < "$WALLET_SECRET_INPUT"
hodl swap quote --wallet treasury --amount 100 --to "$BTC_ADDRESS" < "$WALLET_SECRET_INPUT"
hodl swap destination --wallet treasury --network btc < "$WALLET_SECRET_INPUT"
hodl swap quote --wallet treasury --network btc --amount 0.01 --to "$BSC_ADDRESS" < "$WALLET_SECRET_INPUT"
hodl swap execute --wallet treasury --quote-id "$QUOTE_ID" \
  --request-id swap-001 --yes --watch < "$WALLET_SECRET_INPUT"
hodl swap status --wallet treasury --request-id swap-001 --watch < "$WALLET_SECRET_INPUT"
hodl swap list --wallet treasury < "$WALLET_SECRET_INPUT"
hodl swap resume --wallet treasury --request-id swap-001 --yes --watch < "$WALLET_SECRET_INPUT"
```

`WALLET_SECRET_INPUT` identifies your existing protected JSON stdin source;
passwords remain off command-line arguments. `quote` saves a short-lived quote
but does not sign, open a deposit channel or send funds. `execute --yes` accepts
that exact quote, including its destination, minimum output and maximum source-network fee
budget. `--watch` emits JSONL progress envelopes followed by the final result.
Without `--watch`, execution returns after publishing the next funding step;
use `resume --yes` to continue after an approval confirms. `status` only observes
and never submits a transaction. Only one unfinished swap per profile is
allowed, and it blocks other HODL BSC and Bitcoin transfers until resolved.

The minimum destination amount for a full swap limits deterioration from the accepted quote to 0.5%.
This is separate from total fees. Source approvals grant only the required
amount to the configured THORChain router. Signed transactions and provider
identifiers are saved in the encrypted wallet before broadcasting; a retry uses
the same signed transaction and request ID. Expired quotes or channels cannot
start a new deposit. Closing HODL stops local monitoring and any remaining
funding steps; it does not cancel a deposit already sent to the protocol.

Bitcoin funding spends confirmed inputs selected when quoting and reserves the
accepted fee budget plus change to the original Bitcoin address. Changed inputs
or a higher fee rate require a new quote. THORChain deposits include its extended
memo outputs; their cost is included in the displayed source-network fee.

Progress distinguishes source funding, provider processing, payout and
confirmations. Completion requires the exact destination payment with **3 Bitcoin
confirmations** or **15 BSC confirmations**, according to the route. Read failures
retain the last known state and report an update error.

Refunds return the source asset to the original sender: USDT on BSC for the
forward route, BTC for the reverse route. Refund and network fees may be deducted.
Streaming can finish partially, with a destination payment and a source refund.
The payment can be below the full-swap minimum in that case. HODL reports
`partial_completed` only after the provider reports every outbound and both
payments are verified; `partial_pending` means verification is still in progress.
A completed exchange with a delayed payout cannot automatically reverse into the
source asset. Protocol failures can require provider support.

The JSON CLI defaults to BSC when `--network` is omitted. Execute, resume and
status use the route stored with the quote or operation; they do not take a new
network selection. Existing BSC-to-Bitcoin operations remain readable.

Swap endpoints, timeouts, gas budgets and confirmation policy are centralized
in `swap/config.ts`. Tests use temporary wallets and simulated networks:
`pnpm run test:swap`. These tests do not transfer real funds.

## 🔒 Security

### 🔍 Security Audit

We encourage users to perform their own security audits. One easy way to do this is to copy the entire codebase into ChatGPT or another AI assistant and ask if the code appears secure or if there are any malicious intentions. This is a good practice for any open-source project you're considering using.

**For a deeper understanding**: [HODL DeepWiki](https://deepwiki.com/clasen/HODL)

### 🔑 Private Key Storage

Your private key is securely stored in a JSON file, encrypted with a password of your choice. The encryption adds an extra layer of security, making it significantly harder for unauthorized parties to access your private key even if they gain access to the JSON file.

### 🔬 Transparency

We're as transparent as your ex's excuses. Our code is open-source, and we encourage you to dive in, explore, and contribute. Trust isn't given; it's earned and verified.

### 📦 Trusted Dependencies

We've carefully selected trusted and well-maintained dependencies for this project. Our goal is to balance functionality with security. Here's a brief overview of our main dependencies:

- Common
  - **inquirer** and **inquirer-autocomplete-prompt**: For interactive command-line interfaces.
  - **inquirer-fuzzy-path**: For fuzzy searching and selecting file paths during HODL file import.
  - **cli-table3**: For creating formatted CLI tables.
  - **ora**: For displaying progress bars.
  - **deepbase**: For persistent storage.
  - **node:crypto**: Native encryption for JSON storage.
  - **bip39**: For generating and handling mnemonic phrases.
- Web3
  - **web3**: The Ethereum JavaScript API for blockchain interactions.
  - **hdkey**: For handling hierarchical deterministic (HD) keys.
- Bitcoin
  - **bitcoinjs-lib**: For Bitcoin-specific operations.
  - **bip32**: For handling hierarchical deterministic (HD) keys.
  - **ecpair**: For elliptic curve pairings.
  - **tiny-secp256k1**: For elliptic curve secp256k1 operations.

⚠️ **Important Notice**: HODL Wallet is a personal project created with the best intentions. While we strive for security, it may contain security flaws or vulnerabilities. Use at your own risk and always exercise caution with your crypto assets.

## 📘 What HODL means

The term "HODL" is a cornerstone of crypto culture, and it's worth understanding its origins:

- 🎂 Born on December 18, 2013, in a Bitcoin Talk forum post
- 🍺 Originally a typo for "HOLD" in a drunk, impassioned rant about not selling Bitcoin
- 🔤 Later backronymed to mean "Hold On for Dear Life"
- 💎 Symbolizes a long-term investment strategy and resistance to panic selling
- 🌍 Now used across various cryptocurrency communities as a rallying cry

HODL embodies the belief in the long-term potential of cryptocurrencies, often in the face of short-term market volatility. It's more than just a misspelling; it's a philosophy that has shaped the crypto landscape.

## 🤝 Contributing

Found a bug? Want to add a feature? We're all ears! Open an issue or submit a PR. Let's make crypto easier together.

## 📜 License

MIT License. Go wild, but don't blame us if you YOLO your life savings into DogeMoonRocket tokens.

---

Remember: With great power comes great responsibility. And with crypto, comes great volatility. HODL responsibly! 🚀🌕
