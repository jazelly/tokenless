import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
const SQLITE_BUSY = 5;
const LOCK_RETRY_INTERVAL_MS = 10;
const MAX_LOCKS = 16;
export const DEFAULT_SQLITE_LOCK_TIMEOUT_MS = 30_000;
export const MAX_SQLITE_LOCK_TIMEOUT_MS = 300_000;
export class SqliteLockError extends Error {
    code;
    retryable;
    constructor(code, message) {
        super(message);
        this.name = 'SqliteLockError';
        this.code = code;
        this.retryable = code === 'sqlite_lock_timeout';
    }
}
/** Holds canonical, deterministically ordered SQLite writer locks in this process. */
export async function withSqliteLocks(options, operation) {
    if (options === null || typeof options !== 'object' || typeof operation !== 'function') {
        throw lockFailure('SQLite lock options and an operation are required.');
    }
    if (!Array.isArray(options.lockFiles)) {
        throw lockFailure('SQLite lock files must be an array.');
    }
    if (options.lockFiles.length === 0 || options.lockFiles.length > MAX_LOCKS) {
        throw lockFailure(`SQLite lock operations require 1-${MAX_LOCKS} lock files.`);
    }
    if (isAborted(options.signal))
        throw lockAborted('before lock preparation');
    const timeoutMs = resolveSqliteLockTimeout(options.timeoutMs);
    const requested = options.lockFiles.map((file) => requireAbsolutePath(file));
    if (hasDuplicatePaths(requested)) {
        throw lockFailure('SQLite lock operations require unique lock files.');
    }
    let lockFiles;
    try {
        lockFiles = await Promise.all(requested.map(preparePrivateLockFile));
    }
    catch (error) {
        if (error instanceof SqliteLockError)
            throw error;
        throw lockFailure('Cannot prepare a private SQLite lock file.');
    }
    lockFiles.sort(comparePaths);
    if (hasDuplicatePaths(lockFiles)) {
        throw lockFailure('SQLite lock paths must remain unique after canonicalization.');
    }
    if (isAborted(options.signal))
        throw lockAborted('before lock acquisition');
    const deadline = performance.now() + timeoutMs;
    const held = [];
    let primaryError;
    let hasPrimaryError = false;
    try {
        for (const file of lockFiles) {
            held.push(await acquireSqliteLock(file, deadline, options.signal));
        }
        if (isAborted(options.signal))
            throw lockAborted('before operation dispatch');
        return await operation();
    }
    catch (error) {
        primaryError = error;
        hasPrimaryError = true;
        throw error;
    }
    finally {
        const releaseError = releaseSqliteLocks(held);
        if (!hasPrimaryError && releaseError !== undefined)
            throw releaseError;
    }
}
export function resolveSqliteLockTimeout(value) {
    const timeoutMs = value ?? DEFAULT_SQLITE_LOCK_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_SQLITE_LOCK_TIMEOUT_MS) {
        throw lockFailure(`SQLite lock timeout must be an integer between 0 and ${MAX_SQLITE_LOCK_TIMEOUT_MS}.`);
    }
    return timeoutMs;
}
async function acquireSqliteLock(file, deadline, signal) {
    let database;
    try {
        database = new DatabaseSync(file);
        await validatePrivateLockFile(file);
        database.exec('PRAGMA busy_timeout = 0');
        let firstAttempt = true;
        while (true) {
            if (isAborted(signal))
                throw lockAborted('while waiting for a lock');
            if (!firstAttempt && performance.now() >= deadline)
                throw lockTimeout();
            firstAttempt = false;
            try {
                database.exec('BEGIN IMMEDIATE');
                return { database, file };
            }
            catch (error) {
                if (!isSqliteBusy(error)) {
                    throw lockFailure('Cannot acquire a SQLite writer lock.');
                }
            }
            const remainingMs = deadline - performance.now();
            if (remainingMs <= 0)
                throw lockTimeout();
            await waitForRetry(Math.min(LOCK_RETRY_INTERVAL_MS, remainingMs), signal);
        }
    }
    catch (error) {
        try {
            database?.close();
        }
        catch {
            // The original acquisition failure is more useful than a close failure.
        }
        if (error instanceof SqliteLockError)
            throw error;
        throw lockFailure('Cannot open a private SQLite lock database.');
    }
}
function releaseSqliteLocks(held) {
    let releaseError;
    for (let index = held.length - 1; index >= 0; index -= 1) {
        const { database } = held[index];
        try {
            database.exec('ROLLBACK');
        }
        catch {
            releaseError ??= lockFailure('Cannot roll back a SQLite lock transaction.');
        }
        try {
            database.close();
        }
        catch {
            releaseError ??= lockFailure('Cannot close a SQLite lock database.');
        }
    }
    return releaseError;
}
async function preparePrivateLockFile(input) {
    const parent = path.resolve(path.dirname(input));
    await ensurePrivateDirectory(parent);
    const canonicalParent = await fs.realpath(parent);
    if (comparePaths(canonicalParent, parent) !== 0) {
        throw lockFailure('The SQLite lock parent cannot contain path aliases or symbolic links.');
    }
    const file = path.join(canonicalParent, path.basename(input));
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    let handle;
    try {
        try {
            handle = await fs.open(file, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
            if (process.platform !== 'win32')
                await handle.chmod(0o600);
        }
        catch (error) {
            if (!isErrno(error, 'EEXIST'))
                throw error;
            await validatePrivateLockFile(file);
            handle = await fs.open(file, fsConstants.O_RDWR | noFollow);
        }
        const opened = await handle.stat();
        assertPrivateFile(opened);
        const linked = await fs.lstat(file);
        assertPrivateFile(linked);
        if (opened.dev !== linked.dev || opened.ino !== linked.ino) {
            throw lockFailure('The SQLite lock path changed while it was opened.');
        }
    }
    catch (error) {
        if (error instanceof SqliteLockError)
            throw error;
        throw lockFailure('Cannot create or validate a private SQLite lock file.');
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
    return file;
}
async function ensurePrivateDirectory(directory) {
    try {
        const created = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        if (created !== undefined && process.platform !== 'win32')
            await fs.chmod(directory, 0o700);
        const metadata = await fs.lstat(directory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw lockFailure('The SQLite lock parent must be a real directory.');
        }
        assertCurrentUser(metadata);
        if (process.platform !== 'win32' && (metadata.mode & 0o7777) !== 0o700) {
            throw lockFailure('The SQLite lock parent must have mode 0700.');
        }
    }
    catch (error) {
        if (error instanceof SqliteLockError)
            throw error;
        throw lockFailure('Cannot create or validate the private SQLite lock directory.');
    }
}
async function validatePrivateLockFile(file) {
    let metadata;
    try {
        metadata = await fs.lstat(file);
    }
    catch {
        throw lockFailure('Cannot inspect the SQLite lock file.');
    }
    assertPrivateFile(metadata);
}
function assertPrivateFile(metadata) {
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw lockFailure('The SQLite lock must be a regular non-symlink file.');
    }
    if (Number(metadata.nlink) !== 1) {
        throw lockFailure('The SQLite lock file must not have hard links.');
    }
    assertCurrentUser(metadata);
    if (process.platform !== 'win32' && (Number(metadata.mode) & 0o7777) !== 0o600) {
        throw lockFailure('The SQLite lock file must have mode 0600.');
    }
}
function assertCurrentUser(metadata) {
    if (typeof process.getuid === 'function' && Number(metadata.uid) !== process.getuid()) {
        throw lockFailure('The SQLite lock path must be owned by the current user.');
    }
}
function requireAbsolutePath(value) {
    if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) {
        throw lockFailure('Every SQLite lock file must be an absolute path without NUL bytes.');
    }
    return path.resolve(value);
}
function comparePaths(left, right) {
    if (process.platform !== 'win32')
        return Buffer.from(left).compare(Buffer.from(right));
    const normalizedLeft = left.toLowerCase();
    const normalizedRight = right.toLowerCase();
    if (normalizedLeft === normalizedRight)
        return 0;
    return normalizedLeft < normalizedRight ? -1 : 1;
}
function hasDuplicatePaths(files) {
    const ordered = [...files].sort(comparePaths);
    return ordered.some((file, index) => index > 0 && comparePaths(ordered[index - 1], file) === 0);
}
function waitForRetry(delayMs, signal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (error === undefined)
                resolve();
            else
                reject(error);
        };
        const onAbort = () => finish(lockAborted('while waiting for a lock'));
        const timer = setTimeout(() => finish(), Math.max(0, Math.ceil(delayMs)));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (isAborted(signal))
            onAbort();
    });
}
function isSqliteBusy(error) {
    return error !== null && typeof error === 'object' && 'errcode' in error && error.errcode === SQLITE_BUSY;
}
function isAborted(signal) {
    return signal?.aborted === true;
}
function isErrno(error, code) {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}
function lockAborted(stage) {
    return new SqliteLockError('sqlite_lock_aborted', `The SQLite lock operation was aborted ${stage}.`);
}
function lockTimeout() {
    return new SqliteLockError('sqlite_lock_timeout', 'Timed out waiting for a Tokenless SQLite lock.');
}
function lockFailure(message) {
    return new SqliteLockError('sqlite_lock_failed', message);
}
//# sourceMappingURL=sqlite-lock.js.map