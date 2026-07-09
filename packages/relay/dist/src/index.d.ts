export declare const RELAY_PROTOCOL_VERSION = "tokenless.relay.v1";
export type RelayRunInput = {
    requestId?: string;
    provider?: string;
    action?: string;
    prompt?: string;
    targetUrl?: string;
    context?: unknown;
    metadata?: unknown;
};
export type RelayRun = Required<Pick<RelayRunInput, 'requestId' | 'provider' | 'action'>> & {
    protocol: typeof RELAY_PROTOCOL_VERSION;
    prompt?: string | undefined;
    targetUrl?: string | undefined;
    context?: unknown;
    metadata?: unknown;
};
type RelayError = {
    code: string;
    message: string;
    retryable: boolean;
};
export type RelayRunValidation = {
    ok: true;
    run: RelayRun;
} | {
    ok: false;
    error: RelayError;
};
type RelayExecutionResult = {
    ok: true;
    result?: unknown;
} | {
    ok: false;
    error?: Partial<RelayError>;
};
export declare function createRelayRun(input?: RelayRunInput): RelayRun;
export declare function validateRelayRun(payload: unknown): RelayRunValidation;
export declare function createRelayResult(run: Partial<RelayRun> | null | undefined, result: RelayExecutionResult): {
    protocol: string;
    requestId: string | null;
    ok: boolean;
    provider: string | null;
    action: string | null;
    result: {} | null;
    error: RelayError | null;
};
export {};
//# sourceMappingURL=index.d.ts.map