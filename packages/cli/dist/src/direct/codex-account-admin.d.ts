import { AccountPoolStore, type AccountRecord, type CodexAccountRecord } from './account-pool.js';
export type CodexAccountAdminOptions = Readonly<{
    homeDir: string;
    codexExecutable?: string | undefined;
    lockTimeoutMs?: number | undefined;
    loginTimeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
}>;
export type CodexAccountHealth = 'disabled' | 'healthy' | 'identity_mismatch' | 'pending' | 'unavailable' | 'unverifiable';
export type CodexAccountStatus = Readonly<{
    provider: 'chatgpt';
    accountId: string;
    enabled: boolean;
    lifecycle: 'pending' | 'ready';
    health: CodexAccountHealth;
    reason?: string | undefined;
}>;
export declare class CodexAccountAdminError extends Error {
    readonly code: 'codex_account_login_aborted' | 'codex_account_login_failed' | 'codex_account_login_not_pending' | 'codex_account_login_timeout' | 'codex_account_not_ready' | 'codex_account_wrong_driver';
    readonly retryable: boolean;
    constructor(code: CodexAccountAdminError['code'], message: string, retryable?: boolean);
}
export declare function createManagedAccountPoolStore(options: {
    homeDir: string;
    lockTimeoutMs?: number | undefined;
}): AccountPoolStore;
export declare function chatGptLoginLockPath(homeDir: string): string;
export declare function chatGptInferenceLockPath(homeDir: string): string;
export declare function addManagedCodexAccount(input: {
    accountId: string;
    label?: string | undefined;
    enabled?: boolean | undefined;
}, options: CodexAccountAdminOptions): Promise<CodexAccountRecord>;
/** Runs provider-owned login, verifies structured identity, then finalizes pending state. */
export declare function loginManagedCodexAccount(accountId: string, options: CodexAccountAdminOptions & {
    deviceAuth?: boolean | undefined;
}): Promise<CodexAccountStatus>;
export declare function inspectManagedCodexAccount(accountId: string, options: CodexAccountAdminOptions): Promise<CodexAccountStatus>;
export declare function publicAccountRecord(account: AccountRecord): Record<string, unknown>;
//# sourceMappingURL=codex-account-admin.d.ts.map