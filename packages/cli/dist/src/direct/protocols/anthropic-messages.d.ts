import type { DirectRunRequest, DirectUsage } from '../types.js';
export declare const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS = 4096;
export declare const ANTHROPIC_VERSION = "2023-06-01";
export declare function anthropicMessagesBody(request: DirectRunRequest, model: string): {
    model: string;
    max_tokens: number;
    messages: {
        role: string;
        content: string;
    }[];
    stream: boolean;
    temperature?: number;
};
export declare function extractAnthropicMessageText(raw: Record<string, unknown>, requestId: string | undefined): string;
export declare function normalizeAnthropicUsage(value: unknown): DirectUsage | undefined;
//# sourceMappingURL=anthropic-messages.d.ts.map