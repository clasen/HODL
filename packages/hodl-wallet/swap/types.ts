import type { WalletAccount } from '../network/types.js';

export type SwapRouteId = 'bsc-btc' | 'btc-bsc';
export type SwapProviderId = 'chainflip' | 'thorchain';
export type SwapState = 'quoted' | 'preparing' | 'approval_pending' | 'deposit_pending' |
    'deposit_confirmed' | 'swapping' | 'payout_pending' | 'btc_pending' | 'btc_confirming' | 'output_pending' | 'output_confirming' |
    'completed' | 'partial_pending' | 'partial_completed' | 'refund_pending' | 'refunded' | 'failed' | 'needs_attention';

export type SwapInput = { routeId: SwapRouteId; from: string; to: string; amount: string; amountBaseUnits: string };
export type SwapFee = { label: string; asset: string; amountBaseUnits: string; decimals: number };
export type ProviderQuote = {
    provider: SwapProviderId;
    expectedBaseUnits: string;
    minimumBaseUnits: string;
    expiresAt: number;
    estimatedSeconds: number | null;
    fees: SwapFee[];
    details: Record<string, unknown>;
};
export type SwapQuote = SwapInput & ProviderQuote & {
    id: string;
    createdAt: number;
    funding: FundingEstimate;
    netOutputBaseUnits: string;
    costBps: number;
    costUsd: string;
    reference: SwapPrices;
};
export type SwapPrices = { btc: string; bnb: string; usdt: string; updatedAt: number };
export type SwapPlan = {
    depositAddress: string;
    expiresAt: number;
    providerId?: string;
    router?: string;
    memo?: string;
    expirySeconds?: number;
    channelExpiryBlock?: string;
};
export type SwapStep = {
    kind: 'reset_approval' | 'approve' | 'deposit';
    rawTransaction: string;
    hash: string;
    nonce?: string;
    confirmed: boolean;
    broadcastAttempted: boolean;
};
export type SwapOperation = {
    id: string;
    quote: SwapQuote;
    state: SwapState;
    createdAt: number;
    updatedAt: number;
    lastCheckedAt?: number;
    message?: string;
    updateError?: string;
    plan?: SwapPlan;
    openingChannel?: boolean;
    steps: SwapStep[];
    payoutHash?: string;
    payoutBaseUnits?: string;
    confirmations?: number;
    refundHash?: string;
    refundBaseUnits?: string;
    refundConfirmations?: number;
    history: Array<{ state: SwapState; at: number }>;
};
export type ProviderProgress = {
    settlementComplete?: boolean;
    state: 'deposit_pending' | 'deposit_confirmed' | 'swapping' | 'payout_pending' | 'refund_pending' | 'needs_attention';
    payoutHash?: string;
    payoutBaseUnits?: string;
    refundHash?: string;
    refundBaseUnits?: string;
    message?: string;
};
export interface SwapProvider {
    id: SwapProviderId;
    quote(input: SwapInput): Promise<ProviderQuote>;
    prepare(quote: SwapQuote): Promise<SwapPlan>;
    validate(quote: SwapQuote, plan: SwapPlan): Promise<void>;
    status(operation: SwapOperation): Promise<ProviderProgress>;
}
export type ChainReceipt = { state: 'not_found' | 'pending' | 'confirmed' | 'reverted'; confirmations: number };
export type BitcoinInput = { txid: string; vout: number; value: number };
export type FundingEstimate = {
    asset: 'BNB' | 'BTC';
    decimals: number;
    price: 'bnb' | 'btc';
    budgetBaseUnits: string;
    rate: string;
    units: number;
    inputs?: BitcoinInput[];
};
export type FundingBalance = { sufficientAsset: boolean; sufficientFee: boolean };
export interface SwapChain {
    availableBalance(address: string): Promise<bigint>;
    estimate(input: SwapInput, offer: ProviderQuote): Promise<FundingEstimate>;
    balance(input: SwapInput, funding: FundingEstimate): Promise<FundingBalance>;
    checkFunding(quote: SwapQuote, steps: SwapStep[]): Promise<void>;
    assertAvailable(address: string): Promise<void>;
    nextStep(quote: SwapQuote, plan: SwapPlan, steps: SwapStep[]): Promise<SwapStep['kind']>;
    sign(quote: SwapQuote, plan: SwapPlan, kind: SwapStep['kind'], account: WalletAccount): Promise<SwapStep>;
    broadcast(step: SwapStep): Promise<void>;
    receipt(hash: string): Promise<ChainReceipt>;
    blockNumber(): Promise<bigint>;
    payoutPayment(hash: string, address: string): Promise<{ amount: bigint; confirmations: number }>;
    refundPayment(hash: string, address: string): Promise<{ amount: bigint; confirmations: number }>;
}

export const terminalSwapStates: readonly SwapState[] = ['completed', 'partial_completed', 'refunded', 'failed'];
