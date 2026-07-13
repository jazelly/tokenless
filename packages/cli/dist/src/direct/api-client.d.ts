import { MAX_DIRECT_REQUEST_BYTES } from './api-transport.js';
import type { ResolveDirectApiConfigOptions } from './config.js';
import type { DirectRunRequest, DirectRunResult } from './types.js';
export { MAX_DIRECT_REQUEST_BYTES };
export type ExecuteDirectApiOptions = Omit<ResolveDirectApiConfigOptions, 'provider'>;
export type ExecuteChatGptApiOptions = ExecuteDirectApiOptions;
type DirectApiRaw = Record<string, unknown>;
export declare function executeChatGptApi(request: DirectRunRequest, options?: ExecuteChatGptApiOptions): Promise<DirectRunResult<DirectApiRaw>>;
export declare function executeDirectApi(request: DirectRunRequest, options?: ExecuteDirectApiOptions): Promise<DirectRunResult<DirectApiRaw>>;
//# sourceMappingURL=api-client.d.ts.map