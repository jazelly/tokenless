import type { DirectBackend, DirectProvider, DirectRunRequest, DirectRunResult } from './types.js';
export type ExecuteDirectRunOptions = {
    /** A public API or compatible-gateway base URL. Credentials remain environment-only. */
    baseUrl?: string | undefined;
    /** Includes all provider-client preflight and inference work. */
    timeoutMs?: number | undefined;
    /** Testable/process-local override for TOKENLESS_CODEX_BIN. */
    codexExecutable?: string | undefined;
};
/**
 * Select a direct backend without introducing a transport fallback.
 *
 * ChatGPT defaults to the provider-owned Codex client. Other providers will
 * default to their documented API adapters as those adapters are admitted.
 */
export declare function resolveDirectBackend(provider: DirectProvider, requestedBackend?: DirectBackend | undefined): DirectBackend;
/** Execute one isolated direct request. This function never falls back to visible mode. */
export declare function executeDirectRun(request: DirectRunRequest, options?: ExecuteDirectRunOptions): Promise<DirectRunResult>;
//# sourceMappingURL=client.d.ts.map