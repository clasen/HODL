// plugins/bsc.js
module.exports = {
    name: '[BEP-20] Binance Smart Chain',
    explorer: 'https://bscscan.com/tx/',
    rpcUrl: 'https://bsc-dataseed.binance.org/',
    nativeToken: 'BNB',
    tokens: {
        'USDT': '0x55d398326f99059fF775485246999027B3197955', // Dirección del contrato USDT en BSC
        'BNB': '0x0000000000000000000000000000000000000000', // Dirección nativa (BNB)
        // Puedes agregar otros tokens BEP20 aquí
    },
};
