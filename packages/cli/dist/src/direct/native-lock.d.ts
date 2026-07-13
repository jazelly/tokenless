export declare const DEFAULT_NATIVE_LOCK_TIMEOUT_MS = 30000;
export declare const MAX_NATIVE_LOCK_TIMEOUT_MS = 300000;
export type NativeLockErrorCode = 'native_lock_aborted' | 'native_lock_failed' | 'native_lock_lost' | 'native_lock_timeout';
export declare class NativeLockError extends Error {
    readonly code: NativeLockErrorCode;
    readonly retryable: boolean;
    constructor(code: NativeLockErrorCode, message: string);
}
export type WithNativeLocksOptions = Readonly<{
    runner: string;
    lockFiles: readonly string[];
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
}>;
/** Holds a sorted set of native advisory locks for one in-process operation. */
export declare function withNativeLocks<T>(options: WithNativeLocksOptions, operation: () => Promise<T>): Promise<T>;
export declare function resolveNativeLockTimeout(value: number | undefined): number;
//# sourceMappingURL=native-lock.d.ts.map