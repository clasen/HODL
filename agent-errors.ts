export type AgentErrorCode =
    | 'INVALID_ARGUMENT'
    | 'INVALID_STDIN'
    | 'STDIN_REQUIRED'
    | 'PROFILE_EXISTS'
    | 'PROFILE_NOT_FOUND'
    | 'WRONG_PASSWORD'
    | 'ACCOUNT_NOT_FOUND'
    | 'PROFILE_LOCKED'
    | 'IDEMPOTENCY_CONFLICT'
    | 'NETWORK_ERROR'
    | 'TRANSFER_FAILED'
    | 'BROADCAST_UNKNOWN'
    | 'INTERNAL_ERROR';

export class AgentError extends Error {
    readonly code: AgentErrorCode;
    readonly exitCode: 2 | 3 | 4 | 5;
    readonly details?: Record<string, unknown>;

    constructor(
        code: AgentErrorCode,
        message: string,
        exitCode: 2 | 3 | 4 | 5,
        details?: Record<string, unknown>
    ) {
        super(message);
        this.name = 'AgentError';
        this.code = code;
        this.exitCode = exitCode;
        this.details = details;
    }
}
