import { DirectError } from './types.js';
import type { DirectErrorCode, DirectRunRequest, DirectRunResult } from './types.js';
export type DirectOfficialClientErrorReason = 'codex_aborted' | 'codex_binary_missing' | 'codex_binary_not_executable' | 'codex_cleanup_failed' | 'codex_invalid_output' | 'codex_not_chatgpt_authenticated' | 'codex_nonzero_exit' | 'codex_operational_failure' | 'codex_prompt_too_large' | 'codex_timeout' | 'codex_unsupported' | 'invalid_request' | 'unsupported_official_client_provider';
export declare class DirectOfficialClientError extends DirectError {
    readonly reason: DirectOfficialClientErrorReason;
    readonly stage?: OfficialCodexStage;
    readonly exitCode?: number | null;
    constructor({ code, reason, message, retryable, stage, exitCode, }: {
        code: DirectErrorCode;
        reason: DirectOfficialClientErrorReason;
        message: string;
        retryable?: boolean;
        stage?: OfficialCodexStage;
        exitCode?: number | null;
    });
    toJSON(): {
        name: 'DirectError';
        code: DirectErrorCode;
        message: string;
        retryable: boolean;
        status?: number | undefined;
        requestId?: string | undefined;
        reason: DirectOfficialClientErrorReason;
        stage?: OfficialCodexStage;
        exitCode?: number | null;
    };
}
export type OfficialCodexOptions = {
    /** Overrides TOKENLESS_CODEX_BIN. The value is always spawned directly, never through a shell. */
    executable?: string | undefined;
    /** Includes capability checks and login-status preflight, not only inference time. */
    timeoutMs?: number | undefined;
};
type OfficialCodexStage = 'capability' | 'authentication' | 'execution';
/**
 * Run the provider-owned Codex client for a ChatGPT-plan request.
 *
 * Tokenless never reads Codex's credential store. Codex receives the prompt only
 * on stdin and runs from a newly-created, empty working directory.
 */
export declare function runOfficialCodex(request: DirectRunRequest, options?: OfficialCodexOptions): Promise<DirectRunResult>;
export {};
//# sourceMappingURL=official-client.d.ts.map