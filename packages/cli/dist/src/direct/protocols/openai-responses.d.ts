import type { DirectRunRequest, DirectUsage } from '../types.js';
export declare function openAiResponsesBody(request: DirectRunRequest, model: string): {
    model: string;
    input: string;
    stream: boolean;
    store: boolean;
    max_output_tokens?: number;
    temperature?: number;
};
export declare function extractOpenAiResponseText(raw: Record<string, unknown>, requestId: string | undefined): string;
export declare function normalizeOpenAiUsage(value: unknown): DirectUsage | undefined;
export declare function openAiBodyRequestId(raw: Record<string, unknown>, apiKey: string): string | undefined;
//# sourceMappingURL=openai-responses.d.ts.map