import type { DirectProvider } from './types.js';
export declare const DEFAULT_DIRECT_CHATGPT_BASE_URL = "https://api.openai.com";
export declare const DEFAULT_DIRECT_CLAUDE_BASE_URL = "https://api.anthropic.com";
export declare const DEFAULT_DIRECT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
export declare const DEFAULT_DIRECT_GROK_BASE_URL = "https://api.x.ai";
export declare const DEFAULT_DIRECT_TIMEOUT_MS = 120000;
export declare const MAX_DIRECT_TIMEOUT_MS = 600000;
export type ResolveDirectApiConfigOptions = {
    provider?: DirectProvider | undefined;
    baseUrl?: string | undefined;
    timeoutMs?: number | undefined;
};
export type ResolvedDirectApiConfig = Readonly<{
    provider: DirectProvider;
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
}>;
export declare function resolveDirectApiConfig(options?: ResolveDirectApiConfigOptions): ResolvedDirectApiConfig;
export declare function validateDirectBaseUrl(value: string): string;
export declare function responsesUrl(baseUrl: string): string;
export declare function chatGptResponsesUrl(baseUrl: string): string;
export declare function anthropicMessagesUrl(baseUrl: string): string;
export declare function geminiGenerateContentUrl(baseUrl: string, model: string): string;
export declare function antigravityAnthropicMessagesUrl(baseUrl: string): string;
export declare function antigravityGeminiGenerateContentUrl(baseUrl: string, model: string): string;
//# sourceMappingURL=config.d.ts.map