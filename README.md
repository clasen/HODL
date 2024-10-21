# 🧊 HODL Wallet - Fast CLI crypto wallet!

#### 📦 Install and try!
```bash
npm install -g hodl-wallet
hodl
```

![HODL Wallet](https://raw.githubusercontent.com/clasen/HODL/refs/heads/master/example.jpg)

## 🚀 Why HODL Wallet?

Let's face it, Trust Wallet's sluggishness and annoying ads are so last season. HODL Wallet is here to agilize your crypto experience.

- 🏎️ Lightning-fast operations
- 🧊 Cool, minimalist CLI interface
- 🚫 Zero ads, zero BS
- 🔒 Create wallets offline (because paranoia is just good sense in crypto)
- 🔍 Fully transparent, open-source code
- 🌐 Support for both ERC-20 and BEP-20 networks

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

Seamlessly manage your assets on both BEP-20 (Binance Smart Chain) and ERC-20 (Ethereum and Polygon) networks. Switch between networks with ease!

### 💾 Export and Import HODL Files

HODL Wallet now supports exporting and importing encrypted .HODL files, which securely store your wallet information.

- **Export HODL File**: Save your wallet data (including private keys and addresses) to an encrypted .HODL file.
- **Import HODL File**: Restore your wallet from a previously exported .HODL file.

These files are encrypted using your wallet password, providing an additional layer of security for storing and transferring your wallet information.

The main advantage of exporting a HODL file is that to access the private key, you need BOTH the file AND the password. This two-factor approach significantly enhances security. However, keep in mind that this solution is only compatible with HODL Wallet.

## 🔒 Security

### 🔍 Security Audit

We encourage users to perform their own security audits. One easy way to do this is to copy the entire codebase into ChatGPT or another AI assistant and ask if the code appears secure or if there are any malicious intentions. This is a good practice for any open-source project you're considering using.

### 🔑 Private Key Storage

Your private key is securely stored in a JSON file, encrypted with a password of your choice. The encryption adds an extra layer of security, making it significantly harder for unauthorized parties to access your private key even if they gain access to the JSON file.

### 🔬 Transparency

We're as transparent as your ex's excuses. Our code is open-source, and we encourage you to dive in, explore, and contribute. Trust isn't given; it's earned and verified.

### 📦 Trusted Dependencies

We've carefully selected trusted and well-maintained dependencies for this project. Our goal is to balance functionality with security. Here's a brief overview of our main dependencies:

- **web3**: The Ethereum JavaScript API for blockchain interactions.
- **deepbase**: For persistent storage.
- **crypto-js**: For encryption.
- **inquirer** and **inquirer-autocomplete-prompt**: For interactive command-line interfaces.
- **inquirer-fuzzy-path**: For fuzzy searching and selecting file paths during HODL file import.
- **cli-table3**: For creating formatted CLI tables.
- **bip39**: For generating and handling mnemonic phrases.
- **hdkey**: For handling hierarchical deterministic (HD) keys.

⚠️ **Important Notice**: HODL Wallet is a personal project created with the best intentions. While we strive for security, it may contain security flaws or vulnerabilities. Use at your own risk and always exercise caution with your crypto assets.

## 🤝 Contributing

Found a bug? Want to add a feature? We're all ears! Open an issue or submit a PR. Let's make crypto easier together.

## 📜 License

MIT License. Go wild, but don't blame us if you YOLO your life savings into DogeMoonRocket tokens.

---

Remember: With great power comes great responsibility. And with crypto, comes great volatility. HODL responsibly! 🚀🌕
