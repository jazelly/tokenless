import { type AccountPoolSerialization } from './account-pool.js';
export type SqliteAccountPoolSerializationOptions = Readonly<{
    homeDir: string;
    timeoutMs?: number | undefined;
}>;
export declare class AccountPoolLockError extends Error {
    readonly code: 'account_pool_lock_failed' | 'account_pool_lock_timeout';
    readonly retryable: boolean;
    constructor(code: 'account_pool_lock_failed' | 'account_pool_lock_timeout', message: string);
}
export declare function accountPoolLockPath(homeDir: string): string;
/** Builds the production registry serializer backed by caller-owned SQLite locks. */
export declare function createSqliteAccountPoolSerialization(options: SqliteAccountPoolSerializationOptions): AccountPoolSerialization;
//# sourceMappingURL=account-pool-lock.d.ts.map