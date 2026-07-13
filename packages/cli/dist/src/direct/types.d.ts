export declare const DIRECT_PROTOCOL: 'tokenless.direct.v1';
export type DirectProtocol = typeof DIRECT_PROTOCOL;
export type DirectProvider = 'chatgpt' | 'claude' | 'gemini' | 'grok' | 'antigravity';
export type DirectBackend = 'official-client' | 'api';
export type DirectTransport = 'official-codex' | 'direct-api';
export type DirectCapability = 'openai.codex' | 'openai.responses' | 'anthropic.messages' | 'google.generateContent' | 'xai.responses' | 'antigravity.anthropic.messages' | 'antigravity.google.generateContent';
export type DirectRunRequest = {
    provider: DirectProvider;
    model?: string | undefined;
    prompt: string;
    backend?: DirectBackend | undefined;
    maxOutputTokens?: number | undefined;
    temperature?: number | undefined;
    signal?: AbortSignal | undefined;
};
export type DirectUsage = {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
};
export type DirectRunResult<TRaw = unknown> = {
    protocol: DirectProtocol;
    backend: DirectBackend;
    transport: DirectTransport;
    capability: DirectCapability;
    provider: DirectProvider;
    model?: string | undefined;
    text: string;
    usage?: DirectUsage | undefined;
    requestId?: string | undefined;
    raw: TRaw;
};
export type DirectErrorCode = 'direct_configuration_error' | 'direct_insecure_upstream' | 'direct_unsupported_provider' | 'direct_ambiguous_model' | 'direct_authentication_failed' | 'direct_rate_limited' | 'direct_upstream_error' | 'direct_timeout' | 'direct_invalid_response' | 'direct_request_too_large';
export type DirectErrorOptions = {
    retryable?: boolean | undefined;
    status?: number | undefined;
    requestId?: string | undefined;
};
export type DirectErrorJson = {
    name: 'DirectError';
    code: DirectErrorCode;
    message: string;
    retryable: boolean;
    status?: number | undefined;
    requestId?: string | undefined;
};
export declare class DirectError extends Error {
    readonly code: DirectErrorCode;
    readonly retryable: boolean;
    readonly status?: number | undefined;
    readonly requestId?: string | undefined;
    constructor(code: DirectErrorCode, message: string, options?: DirectErrorOptions);
    toJSON(): DirectErrorJson;
}
//# sourceMappingURL=types.d.ts.map