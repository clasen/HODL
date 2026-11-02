export const walletConfig = {
    history: {
        recentTransfers: 10,
        /** Transfers kept per address and network once scans have found more. */
        keptTransfers: 500,
        /** Leading or trailing characters an incoming sender shares with a known address to be hidden as an imitation. */
        lookAlikeChars: 4
    }
};
