import path from 'node:path';
import fs from 'node:fs/promises';
import { accountPoolDirectDirectory, accountPoolStatePath, withProcessLocalAccountPoolSerialization, } from './account-pool.js';
import { SqliteLockError, resolveSqliteLockTimeout, withSqliteLocks, } from './sqlite-lock.js';
export class AccountPoolLockError extends Error {
    code;
    retryable;
    constructor(code, message) {
        super(message);
        this.name = 'AccountPoolLockError';
        this.code = code;
        this.retryable = code === 'account_pool_lock_timeout';
    }
}
export function accountPoolLockPath(homeDir) {
    return path.join(accountPoolDirectDirectory(homeDir), 'account-pool.lock');
}
/** Builds the production registry serializer backed by caller-owned SQLite locks. */
export function createSqliteAccountPoolSerialization(options) {
    if (options === null || typeof options !== 'object') {
        throw lockError('SQLite account-pool lock options are required.');
    }
    const homeDir = path.resolve(options.homeDir);
    const expectedStateFile = accountPoolStatePath(homeDir);
    const timeoutMs = resolveSqliteLockTimeout(options.timeoutMs);
    let lockFilePromise;
    const resolveLockFile = () => {
        lockFilePromise ??= fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
            .then(() => fs.realpath(homeDir))
            .then((canonicalHome) => accountPoolLockPath(canonicalHome));
        return lockFilePromise;
    };
    return async (stateFile, operation) => {
        if (path.resolve(stateFile) !== expectedStateFile) {
            throw lockError('The SQLite account-pool serializer refused an unexpected registry path.');
        }
        return withProcessLocalAccountPoolSerialization(stateFile, async () => {
            const lockFile = await resolveLockFile();
            try {
                return await withSqliteLocks({ lockFiles: [lockFile], timeoutMs }, operation);
            }
            catch (error) {
                if (!(error instanceof SqliteLockError))
                    throw error;
                throw new AccountPoolLockError(error.code === 'sqlite_lock_timeout' ? 'account_pool_lock_timeout' : 'account_pool_lock_failed', error.message);
            }
        });
    };
}
function lockError(message) {
    return new AccountPoolLockError('account_pool_lock_failed', message);
}
//# sourceMappingURL=account-pool-lock.js.map