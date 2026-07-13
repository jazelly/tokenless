export declare const DEFAULT_SQLITE_LOCK_TIMEOUT_MS = 30000;
export declare const MAX_SQLITE_LOCK_TIMEOUT_MS = 300000;
export type SqliteLockErrorCode = 'sqlite_lock_aborted' | 'sqlite_lock_failed' | 'sqlite_lock_timeout';
export declare class SqliteLockError extends Error {
    readonly code: SqliteLockErrorCode;
    readonly retryable: boolean;
    constructor(code: SqliteLockErrorCode, message: string);
}
export type WithSqliteLocksOptions = Readonly<{
    lockFiles: readonly string[];
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
}>;
/** Holds canonical, deterministically ordered SQLite writer locks in this process. */
export declare function withSqliteLocks<T>(options: WithSqliteLocksOptions, operation: () => Promise<T>): Promise<T>;
export declare function resolveSqliteLockTimeout(value: number | undefined): number;
//# sourceMappingURL=sqlite-lock.d.ts.map