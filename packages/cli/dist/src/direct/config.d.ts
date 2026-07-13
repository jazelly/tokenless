export declare const DEFAULT_DIRECT_CHATGPT_BASE_URL = "https://api.openai.com";
export declare const DEFAULT_DIRECT_TIMEOUT_MS = 120000;
export declare const MAX_DIRECT_TIMEOUT_MS = 600000;
export type ResolveDirectApiConfigOptions = {
    provider?: 'chatgpt' | undefined;
    baseUrl?: string | undefined;
    timeoutMs?: number | undefined;
};
export type ResolvedDirectApiConfig = Readonly<{
    provider: 'chatgpt';
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
}>;
export declare function resolveDirectApiConfig(options?: ResolveDirectApiConfigOptions): ResolvedDirectApiConfig;
export declare function validateDirectBaseUrl(value: string): string;
export declare function chatGptResponsesUrl(baseUrl: string): string;
//# sourceMappingURL=config.d.ts.map