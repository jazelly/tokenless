import type { DirectRunRequest, DirectRunResult } from './types.js';
import type { ResolveDirectApiConfigOptions } from './config.js';
export declare const MAX_DIRECT_REQUEST_BYTES: number;
export type ExecuteChatGptApiOptions = Omit<ResolveDirectApiConfigOptions, 'provider'>;
type OpenAiResponsesRaw = Record<string, unknown>;
export declare function executeChatGptApi(request: DirectRunRequest, options?: ExecuteChatGptApiOptions): Promise<DirectRunResult<OpenAiResponsesRaw>>;
export {};
//# sourceMappingURL=api-client.d.ts.map