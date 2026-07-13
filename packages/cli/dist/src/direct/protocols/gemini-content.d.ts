import type { DirectRunRequest, DirectUsage } from '../types.js';
export declare function geminiGenerateContentBody(request: DirectRunRequest): {
    contents: {
        role: string;
        parts: {
            text: string;
        }[];
    }[];
    store: boolean;
    generationConfig?: {
        maxOutputTokens?: number;
        temperature?: number;
    };
};
export declare function extractGeminiCandidateText(raw: Record<string, unknown>, requestId: string | undefined): string;
export declare function normalizeGeminiUsage(value: unknown): DirectUsage | undefined;
//# sourceMappingURL=gemini-content.d.ts.map