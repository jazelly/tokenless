import { DirectError } from './types.js';
export declare const MAX_DIRECT_REQUEST_BYTES: number;
export type DirectApiAuthentication = Readonly<{
    kind: 'bearer';
    apiKey: string;
}> | Readonly<{
    kind: 'x-api-key';
    apiKey: string;
}> | Readonly<{
    kind: 'anthropic';
    apiKey: string;
    version: string;
}> | Readonly<{
    kind: 'google';
    apiKey: string;
}>;
export type DirectJsonRequest = Readonly<{
    endpoint: string;
    authentication: DirectApiAuthentication;
    body: unknown;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    requestIdHeaders: readonly string[];
}>;
export type DirectJsonResponse = Readonly<{
    raw: Record<string, unknown>;
    requestId?: string | undefined;
}>;
export declare function postDirectJson(request: DirectJsonRequest): Promise<DirectJsonResponse>;
export declare function invalidResponseError(message: string, requestId: string | undefined): DirectError;
export declare function normalizeResponseRequestId(value: unknown, apiKey: string): string | undefined;
//# sourceMappingURL=api-transport.d.ts.map