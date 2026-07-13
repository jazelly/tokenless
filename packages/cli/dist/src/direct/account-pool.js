import { createHash, randomUUID as createRandomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tokenlessHome } from '../job-store.js';
export const ACCOUNT_POOL_PROTOCOL = 'tokenless.account-pool.v1';
const ACCOUNT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ROUTING_DOMAIN_PATTERN = ACCOUNT_ID_PATTERN;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{0,126}[A-Za-z0-9])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODEX_IDENTITY_FINGERPRINT_PATTERN = /^tokenless\.codex-identity\.v1:[A-Za-z0-9_-]{43}$/;
const MAX_REGISTRY_BYTES = 4 * 1_024 * 1_024;
const MAX_LABEL_CHARACTERS = 128;
const MAX_API_CONCURRENCY = 128;
const PROVIDERS = Object.freeze([
    'chatgpt',
    'claude',
    'gemini',
    'grok',
    'antigravity',
]);
export class AccountPoolError extends Error {
    code;
    retryable = false;
    constructor(code, message) {
        super(message);
        this.name = 'AccountPoolError';
        this.code = code;
    }
}
const PROCESS_LOCAL_MUTATION_TAILS = new Map();
/**
 * Serializes registry read-modify-write operations across store instances in this
 * process. Production wraps this seam with a caller-owned cross-process lock
 * without changing the registry mutation contract.
 */
export async function withProcessLocalAccountPoolSerialization(stateFile, operation) {
    const key = path.resolve(stateFile);
    const previous = PROCESS_LOCAL_MUTATION_TAILS.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    PROCESS_LOCAL_MUTATION_TAILS.set(key, tail);
    await previous.catch(() => undefined);
    try {
        return await operation();
    }
    finally {
        release?.();
        if (PROCESS_LOCAL_MUTATION_TAILS.get(key) === tail) {
            PROCESS_LOCAL_MUTATION_TAILS.delete(key);
        }
    }
}
export function accountPoolDirectDirectory(homeDir = tokenlessHome()) {
    return path.join(path.resolve(homeDir), 'direct');
}
export function accountPoolStatePath(homeDir = tokenlessHome()) {
    return path.join(accountPoolDirectDirectory(homeDir), 'account-pool.json');
}
export function accountPoolProfilePath(homeDir, provider, internalId) {
    const normalizedProvider = normalizeProvider(provider);
    if (normalizedProvider !== 'chatgpt') {
        throw invalidError('Managed provider profiles are currently supported only for ChatGPT.');
    }
    const canonicalInternalId = requireCanonicalUuid(internalId);
    const profileRoot = path.join(accountPoolDirectDirectory(homeDir), 'provider-profiles', normalizedProvider, canonicalInternalId);
    return path.join(profileRoot, 'codex');
}
export function accountPoolAccountLockPath(homeDir, provider, internalId) {
    const normalizedProvider = normalizeProvider(provider);
    const canonicalInternalId = requireCanonicalUuid(internalId);
    return path.join(accountPoolDirectDirectory(homeDir), 'account-locks', normalizedProvider, `${canonicalInternalId}.lock`);
}
export function normalizeAccountId(value) {
    if (typeof value !== 'string')
        throw invalidError('Account id must be a string.');
    const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/-+/g, '-');
    if (!ACCOUNT_ID_PATTERN.test(normalized)) {
        throw invalidError('Account id must be a 1-63 character lowercase URL-safe slug.');
    }
    return normalized;
}
export function normalizeRoutingDomain(value) {
    if (typeof value !== 'string')
        throw invalidError('Routing domain must be a string.');
    const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/-+/g, '-');
    if (!ROUTING_DOMAIN_PATTERN.test(normalized)) {
        throw invalidError('Routing domain must be a 1-63 character lowercase URL-safe slug.');
    }
    return normalized;
}
export function apiCredentialEnvironmentName(provider, accountId) {
    const normalizedProvider = normalizeProvider(provider);
    const normalizedAccountId = normalizeAccountId(accountId);
    return `TOKENLESS_DIRECT_ACCOUNT_${normalizedProvider.toUpperCase()}_${normalizedAccountId.toUpperCase().replaceAll('-', '_')}_API_KEY`;
}
export class AccountPoolStore {
    homeDir;
    stateFile;
    #now;
    #randomUUID;
    #serialize;
    constructor(options = {}) {
        this.homeDir = path.resolve(options.homeDir ?? tokenlessHome());
        this.stateFile = accountPoolStatePath(this.homeDir);
        this.#now = options.now ?? (() => new Date());
        this.#randomUUID = options.randomUUID ?? createRandomUUID;
        this.#serialize = options.serialize ?? withProcessLocalAccountPoolSerialization;
    }
    async readSnapshot() {
        return cloneSnapshot(await readSnapshotFile(this.homeDir, this.stateFile));
    }
    async listAccounts(filter = {}) {
        const snapshot = await this.readSnapshot();
        const provider = filter.provider === undefined ? undefined : normalizeProvider(filter.provider);
        return snapshot.accounts
            .filter((account) => provider === undefined || account.provider === provider)
            .map(cloneAccount);
    }
    async listBindings(filter = {}) {
        const snapshot = await this.readSnapshot();
        const projectId = filter.projectId === undefined ? undefined : requireProjectId(filter.projectId);
        const provider = filter.provider === undefined ? undefined : normalizeProvider(filter.provider);
        return snapshot.bindings
            .filter((binding) => ((projectId === undefined || binding.projectId === projectId) &&
            (provider === undefined || binding.provider === provider)))
            .map(cloneBinding);
    }
    async addCodexAccount(input) {
        const account = await this.addAccount({ ...input, provider: 'chatgpt', driver: 'official-codex' });
        return account;
    }
    async addApiAccount(input) {
        const account = await this.addAccount({ ...input, driver: 'api' });
        return account;
    }
    async addAccount(input) {
        if (!isJsonRecord(input))
            throw invalidError('Account input must be an object.');
        rejectSecretFields(input, 'account input');
        if (input.driver === 'official-codex') {
            assertExactKeys(input, ['provider', 'accountId', 'driver'], ['enabled', 'label'], 'account input');
        }
        else if (input.driver === 'api') {
            assertExactKeys(input, ['provider', 'accountId', 'driver', 'routingDomain'], ['enabled', 'maxConcurrency', 'label'], 'account input');
        }
        const provider = normalizeProvider(input.provider);
        const accountId = normalizeAccountId(input.accountId);
        const label = normalizeOptionalLabel(input.label);
        const enabled = input.enabled ?? true;
        if (typeof enabled !== 'boolean')
            throw invalidError('Account enabled must be a boolean.');
        if (input.driver !== 'official-codex' && input.driver !== 'api') {
            throw invalidError('Account driver is unsupported.');
        }
        if (input.driver === 'official-codex' && provider !== 'chatgpt') {
            throw invalidError('The official Codex driver is supported only for ChatGPT accounts.');
        }
        return this.#mutate((snapshot, timestamp) => {
            if (findAccountBySlug(snapshot, provider, accountId) !== undefined) {
                throw new AccountPoolError('account_pool_already_exists', `Account ${provider}/${accountId} already exists.`);
            }
            const internalId = this.#newInternalId(snapshot);
            let account;
            if (input.driver === 'official-codex') {
                account = {
                    provider: 'chatgpt',
                    accountId,
                    internalId,
                    driver: 'official-codex',
                    status: 'pending',
                    enabled,
                    maxConcurrency: 1,
                    ...(label === undefined ? {} : { label }),
                    createdAt: timestamp,
                    updatedAt: timestamp,
                };
            }
            else {
                const routingDomain = normalizeRoutingDomain(input.routingDomain);
                const maxConcurrency = boundedInteger(input.maxConcurrency, 1, 1, MAX_API_CONCURRENCY, 'API account max concurrency');
                account = {
                    provider,
                    accountId,
                    internalId,
                    driver: 'api',
                    status: 'ready',
                    enabled,
                    maxConcurrency,
                    ...(label === undefined ? {} : { label }),
                    credentialEnv: apiCredentialEnvironmentName(provider, accountId),
                    routingDomain,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                };
            }
            snapshot.accounts.push(account);
            return { changed: true, value: cloneAccount(account) };
        });
    }
    async finalizeCodexIdentity(input) {
        if (!isJsonRecord(input))
            throw invalidError('Codex identity input must be an object.');
        rejectSecretFields(input, 'Codex identity input');
        assertExactKeys(input, ['provider', 'accountId', 'expectedInternalId', 'identityFingerprint'], [], 'Codex identity input');
        const provider = normalizeProvider(input.provider);
        if (provider !== 'chatgpt') {
            throw invalidError('Codex identity can be finalized only for ChatGPT accounts.');
        }
        const accountId = normalizeAccountId(input.accountId);
        const expectedInternalId = requireCanonicalUuid(input.expectedInternalId);
        const identityFingerprint = requireCodexIdentityFingerprint(input.identityFingerprint);
        return this.#mutate((snapshot, timestamp) => {
            const account = requireAccountBySlug(snapshot, provider, accountId);
            if (account.internalId !== expectedInternalId) {
                throw new AccountPoolError('account_pool_conflict', 'The account identity reservation changed before Codex onboarding completed.');
            }
            if (account.driver !== 'official-codex') {
                throw new AccountPoolError('account_pool_conflict', 'Only an official Codex account has a Codex identity.');
            }
            const duplicate = snapshot.accounts.find((candidate) => (candidate.driver === 'official-codex' &&
                candidate.internalId !== account.internalId &&
                candidate.identityFingerprint === identityFingerprint));
            if (duplicate !== undefined) {
                throw new AccountPoolError('account_pool_conflict', 'The Codex identity is already registered.');
            }
            if (account.status === 'ready') {
                if (account.identityFingerprint === identityFingerprint)
                    return { changed: false, value: cloneAccount(account) };
                throw new AccountPoolError('account_pool_conflict', 'The registered Codex identity differs; explicitly relink the account before use.');
            }
            const finalized = {
                ...account,
                status: 'ready',
                identityFingerprint,
                updatedAt: timestamp,
            };
            replaceAccount(snapshot, finalized);
            return { changed: true, value: cloneAccount(finalized) };
        });
    }
    async enableAccount(reference) {
        return this.#setAccountEnabled(reference, true);
    }
    async disableAccount(reference) {
        return this.#setAccountEnabled(reference, false);
    }
    async removeAccount(reference) {
        const provider = normalizeProvider(reference.provider);
        const accountId = normalizeAccountId(reference.accountId);
        return this.#mutate((snapshot) => {
            const account = requireAccountBySlug(snapshot, provider, accountId);
            if (snapshot.bindings.some((binding) => binding.accountInternalId === account.internalId)) {
                throw new AccountPoolError('account_pool_bound_account', `Account ${provider}/${accountId} still has project bindings.`);
            }
            snapshot.accounts = snapshot.accounts.filter((candidate) => candidate.internalId !== account.internalId);
            return { changed: true, value: cloneAccount(account) };
        });
    }
    async pinProject(input) {
        const projectId = requireProjectId(input.projectId);
        const provider = normalizeProvider(input.provider);
        const accountId = normalizeAccountId(input.accountId);
        const failoverPolicy = requireFailoverPolicy(input.failoverPolicy ?? 'availability-first');
        return this.#mutate((snapshot, timestamp) => {
            const account = requireAccountBySlug(snapshot, provider, accountId);
            requireRoutableAccount(account);
            const current = findBinding(snapshot, projectId, provider);
            if (current !== undefined &&
                current.accountInternalId === account.internalId &&
                current.failoverPolicy === failoverPolicy) {
                return {
                    changed: false,
                    value: resolution(snapshot.revision, current, account),
                };
            }
            const binding = {
                projectId,
                provider,
                accountInternalId: account.internalId,
                routingDomain: account.driver === 'api' ? account.routingDomain : null,
                failoverPolicy,
                assignedBy: 'explicit',
                generation: (current?.generation ?? 0) + 1,
                createdAt: current?.createdAt ?? timestamp,
                updatedAt: timestamp,
            };
            replaceBinding(snapshot, binding);
            return {
                changed: true,
                value: resolution(snapshot.revision + 1, binding, account),
            };
        });
    }
    async unpinProject(reference) {
        const projectId = requireProjectId(reference.projectId);
        const provider = normalizeProvider(reference.provider);
        return this.#mutate((snapshot) => {
            const current = findBinding(snapshot, projectId, provider);
            if (current === undefined)
                return { changed: false, value: null };
            snapshot.bindings = snapshot.bindings.filter((binding) => (binding.projectId !== projectId || binding.provider !== provider));
            return { changed: true, value: cloneBinding(current) };
        });
    }
    async resolve(reference) {
        const projectId = requireProjectId(reference.projectId);
        const provider = normalizeProvider(reference.provider);
        const snapshot = await this.readSnapshot();
        const binding = findBinding(snapshot, projectId, provider);
        if (binding === undefined)
            return null;
        const account = requireAccountByInternalId(snapshot, binding.accountInternalId);
        return resolution(snapshot.revision, binding, account);
    }
    async resolveOrAssign(input) {
        const projectId = requireProjectId(input.projectId);
        const provider = normalizeProvider(input.provider);
        const routingDomain = normalizeRoutingDomain(input.routingDomain);
        const failoverPolicy = requireFailoverPolicy(input.failoverPolicy ?? 'availability-first');
        return this.#mutate((snapshot, timestamp) => {
            const current = findBinding(snapshot, projectId, provider);
            if (current !== undefined) {
                const account = requireAccountByInternalId(snapshot, current.accountInternalId);
                if (account.driver !== 'api' || account.routingDomain !== routingDomain || current.routingDomain !== routingDomain) {
                    throw new AccountPoolError('account_pool_routing_domain_mismatch', 'The existing project binding belongs to a different routing domain.');
                }
                return { changed: false, value: resolution(snapshot.revision, current, account) };
            }
            const candidates = snapshot.accounts.filter((account) => (account.provider === provider &&
                account.driver === 'api' &&
                account.status === 'ready' &&
                account.enabled &&
                account.routingDomain === routingDomain));
            const account = selectRendezvousAccount(candidates, projectId, provider, routingDomain);
            if (account === undefined) {
                throw new AccountPoolError('account_pool_no_eligible_account', 'No enabled public API account is eligible in the requested routing domain.');
            }
            const binding = {
                projectId,
                provider,
                accountInternalId: account.internalId,
                routingDomain,
                failoverPolicy,
                assignedBy: 'automatic',
                generation: 1,
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            snapshot.bindings.push(binding);
            return {
                changed: true,
                value: resolution(snapshot.revision + 1, binding, account),
            };
        });
    }
    async migrateIfCurrent(input) {
        const projectId = requireProjectId(input.projectId);
        const provider = normalizeProvider(input.provider);
        const expectedAccountInternalId = requireCanonicalUuid(input.expectedAccountInternalId);
        const nextAccountInternalId = requireCanonicalUuid(input.nextAccountInternalId);
        const expectedGeneration = boundedInteger(input.expectedGeneration, undefined, 1, Number.MAX_SAFE_INTEGER, 'expected binding generation');
        return this.#mutate((snapshot, timestamp) => {
            const current = findBinding(snapshot, projectId, provider);
            if (current === undefined) {
                throw new AccountPoolError('account_pool_not_found', 'Project binding was not found.');
            }
            const currentAccount = requireAccountByInternalId(snapshot, current.accountInternalId);
            if (current.accountInternalId !== expectedAccountInternalId ||
                current.generation !== expectedGeneration ||
                current.accountInternalId === nextAccountInternalId) {
                return {
                    changed: false,
                    value: { migrated: false, resolution: resolution(snapshot.revision, current, currentAccount) },
                };
            }
            if (current.failoverPolicy === 'strict') {
                throw new AccountPoolError('account_pool_conflict', 'Strict project bindings cannot be migrated automatically; explicitly pin a different account.');
            }
            const nextAccount = requireAccountByInternalId(snapshot, nextAccountInternalId);
            if (nextAccount.provider !== provider) {
                throw new AccountPoolError('account_pool_conflict', 'Migration target belongs to a different provider.');
            }
            requireRoutableAccount(nextAccount);
            if (nextAccount.driver !== currentAccount.driver) {
                throw new AccountPoolError('account_pool_conflict', 'Migration target uses a different account driver; explicitly pin it instead.');
            }
            if (current.routingDomain !== null &&
                (nextAccount.driver !== 'api' || nextAccount.routingDomain !== current.routingDomain)) {
                throw new AccountPoolError('account_pool_routing_domain_mismatch', 'Migration target belongs to a different routing domain.');
            }
            const migrated = {
                ...current,
                accountInternalId: nextAccount.internalId,
                routingDomain: nextAccount.driver === 'api' ? nextAccount.routingDomain : null,
                assignedBy: 'migration',
                generation: current.generation + 1,
                updatedAt: timestamp,
            };
            replaceBinding(snapshot, migrated);
            return {
                changed: true,
                value: {
                    migrated: true,
                    resolution: resolution(snapshot.revision + 1, migrated, nextAccount),
                },
            };
        });
    }
    async #setAccountEnabled(reference, enabled) {
        const provider = normalizeProvider(reference.provider);
        const accountId = normalizeAccountId(reference.accountId);
        return this.#mutate((snapshot, timestamp) => {
            const account = requireAccountBySlug(snapshot, provider, accountId);
            if (account.enabled === enabled)
                return { changed: false, value: cloneAccount(account) };
            const updated = { ...account, enabled, updatedAt: timestamp };
            replaceAccount(snapshot, updated);
            return { changed: true, value: cloneAccount(updated) };
        });
    }
    #newInternalId(snapshot) {
        for (let attempt = 0; attempt < 16; attempt += 1) {
            const candidate = requireCanonicalUuid(this.#randomUUID());
            if (!snapshot.accounts.some((account) => account.internalId === candidate))
                return candidate;
        }
        throw new AccountPoolError('account_pool_conflict', 'Could not allocate a unique internal account id.');
    }
    async #mutate(operation) {
        return this.#serialize(this.stateFile, async () => {
            const current = await readSnapshotFile(this.homeDir, this.stateFile);
            const snapshot = mutableSnapshot(current);
            const timestamp = requireTimestamp(this.#now().toISOString());
            const result = operation(snapshot, timestamp);
            if (!result.changed)
                return cloneValue(result.value);
            snapshot.protocol = ACCOUNT_POOL_PROTOCOL;
            snapshot.revision = current.revision + 1;
            snapshot.updatedAt = timestamp;
            const next = canonicalSnapshot(snapshot);
            validateSnapshot(next);
            await writeSnapshotAtomic(this.homeDir, this.stateFile, next);
            return cloneValue(result.value);
        });
    }
}
function emptySnapshot() {
    return {
        protocol: ACCOUNT_POOL_PROTOCOL,
        revision: 0,
        updatedAt: null,
        accounts: [],
        bindings: [],
    };
}
async function readSnapshotFile(homeDir, stateFile) {
    const stateDirectory = path.dirname(stateFile);
    const directoryStat = await lstatOrNull(stateDirectory);
    if (directoryStat === null)
        return emptySnapshot();
    assertSecureDirectory(directoryStat, 'Tokenless direct state directory');
    const registryStat = await lstatOrNull(stateFile);
    if (registryStat === null)
        return emptySnapshot();
    assertSecureFile(registryStat, 'Tokenless account pool registry');
    let handle;
    try {
        const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
        handle = await fs.open(stateFile, fsConstants.O_RDONLY | noFollow);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return emptySnapshot();
        if (error instanceof AccountPoolError)
            throw error;
        throw new AccountPoolError('account_pool_unreadable', 'Cannot open the Tokenless account pool registry.');
    }
    try {
        const stat = await handle.stat();
        assertSecureFile(stat, 'Tokenless account pool registry');
        if (stat.size > MAX_REGISTRY_BYTES) {
            throw invalidError('Tokenless account pool registry exceeds the size limit.');
        }
        const contents = await handle.readFile({ encoding: 'utf8' });
        let payload;
        try {
            payload = JSON.parse(contents);
        }
        catch {
            throw invalidError('Tokenless account pool registry is not valid JSON.');
        }
        rejectSecretFields(payload);
        return validateSnapshot(payload);
    }
    catch (error) {
        if (error instanceof AccountPoolError)
            throw error;
        throw new AccountPoolError('account_pool_unreadable', 'Cannot read the Tokenless account pool registry.');
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
async function writeSnapshotAtomic(homeDir, stateFile, snapshot) {
    const stateDirectory = path.dirname(stateFile);
    await ensureSecureDirectory(homeDir);
    await ensureSecureDirectory(stateDirectory);
    const temporary = path.join(stateDirectory, `.account-pool.${process.pid}.${createRandomUUID()}.tmp`);
    let handle;
    try {
        handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8' });
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(temporary, stateFile);
        const directoryHandle = await fs.open(stateDirectory, fsConstants.O_RDONLY);
        try {
            await directoryHandle.sync();
        }
        finally {
            await directoryHandle.close();
        }
    }
    catch (error) {
        await handle?.close().catch(() => undefined);
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        if (error instanceof AccountPoolError)
            throw error;
        throw new AccountPoolError('account_pool_unreadable', 'Cannot persist the Tokenless account pool registry.');
    }
}
async function ensureSecureDirectory(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const before = await fs.lstat(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) {
        throw new AccountPoolError('account_pool_permission_denied', 'Tokenless state path must be a real directory.');
    }
    if (process.platform !== 'win32')
        await fs.chmod(directory, 0o700);
    assertSecureDirectory(await fs.lstat(directory), 'Tokenless state directory');
}
async function lstatOrNull(file) {
    try {
        return await fs.lstat(file);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return null;
        throw new AccountPoolError('account_pool_unreadable', 'Cannot inspect the Tokenless account pool path.');
    }
}
function assertSecureDirectory(stat, name) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new AccountPoolError('account_pool_permission_denied', `${name} must be a real directory.`);
    }
    assertCurrentUserAndPrivateMode(stat, name, 0o077);
}
function assertSecureFile(stat, name) {
    if (!stat.isFile()) {
        throw new AccountPoolError('account_pool_permission_denied', `${name} must be a regular file.`);
    }
    if (Number(stat.nlink) !== 1) {
        throw new AccountPoolError('account_pool_permission_denied', `${name} must not have hard links.`);
    }
    assertCurrentUserAndPrivateMode(stat, name, 0o077);
}
function assertCurrentUserAndPrivateMode(stat, name, forbiddenMode) {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new AccountPoolError('account_pool_permission_denied', `${name} must be owned by the current user.`);
    }
    if (process.platform !== 'win32' && (Number(stat.mode) & forbiddenMode) !== 0) {
        throw new AccountPoolError('account_pool_permission_denied', `${name} permissions are too broad.`);
    }
}
function validateSnapshot(payload) {
    if (!isJsonRecord(payload))
        throw invalidError('Account pool registry must be an object.');
    assertExactKeys(payload, ['protocol', 'revision', 'updatedAt', 'accounts', 'bindings'], [], 'registry');
    if (payload.protocol !== ACCOUNT_POOL_PROTOCOL) {
        throw new AccountPoolError('account_pool_unsupported_protocol', 'Tokenless account pool registry protocol is unsupported.');
    }
    const revision = boundedInteger(payload.revision, undefined, 0, Number.MAX_SAFE_INTEGER, 'registry revision');
    const updatedAt = payload.updatedAt === null ? null : requireTimestamp(payload.updatedAt);
    if ((revision === 0) !== (updatedAt === null)) {
        throw invalidError('Registry revision and updated timestamp are inconsistent.');
    }
    if (!Array.isArray(payload.accounts) || !Array.isArray(payload.bindings)) {
        throw invalidError('Registry accounts and bindings must be arrays.');
    }
    if (revision === 0 && (payload.accounts.length > 0 || payload.bindings.length > 0)) {
        throw invalidError('An uninitialized registry cannot contain records.');
    }
    const accounts = payload.accounts.map((value, index) => validateAccount(value, index));
    const bindings = payload.bindings.map((value, index) => validateBinding(value, index));
    const slugs = new Set();
    const internalIds = new Set();
    const credentialEnvironments = new Set();
    const fingerprints = new Set();
    for (const account of accounts) {
        const slugKey = `${account.provider}\0${account.accountId}`;
        if (slugs.has(slugKey))
            throw invalidError('Registry contains duplicate provider account ids.');
        if (internalIds.has(account.internalId))
            throw invalidError('Registry contains duplicate internal account ids.');
        slugs.add(slugKey);
        internalIds.add(account.internalId);
        if (account.driver === 'api') {
            if (credentialEnvironments.has(account.credentialEnv)) {
                throw invalidError('Registry contains duplicate API credential environment names.');
            }
            credentialEnvironments.add(account.credentialEnv);
        }
        else if (account.identityFingerprint !== undefined) {
            if (fingerprints.has(account.identityFingerprint)) {
                throw invalidError('Registry contains duplicate Codex identity fingerprints.');
            }
            fingerprints.add(account.identityFingerprint);
        }
    }
    const bindingKeys = new Set();
    for (const binding of bindings) {
        const bindingKey = `${binding.projectId}\0${binding.provider}`;
        if (bindingKeys.has(bindingKey))
            throw invalidError('Registry contains duplicate project/provider bindings.');
        bindingKeys.add(bindingKey);
        const account = accounts.find((candidate) => candidate.internalId === binding.accountInternalId);
        if (account === undefined)
            throw invalidError('Registry contains a dangling project binding.');
        if (account.provider !== binding.provider)
            throw invalidError('Project binding provider does not match its account.');
        if (account.status !== 'ready')
            throw invalidError('Project binding targets a pending account.');
        const expectedDomain = account.driver === 'api' ? account.routingDomain : null;
        if (binding.routingDomain !== expectedDomain) {
            throw invalidError('Project binding routing domain does not match its account.');
        }
    }
    return canonicalSnapshot({ protocol: ACCOUNT_POOL_PROTOCOL, revision, updatedAt, accounts, bindings });
}
function validateAccount(value, index) {
    if (!isJsonRecord(value))
        throw invalidError(`Account ${index} must be an object.`);
    const driver = value.driver;
    const common = [
        'provider',
        'accountId',
        'internalId',
        'driver',
        'status',
        'enabled',
        'maxConcurrency',
        'createdAt',
        'updatedAt',
    ];
    if (driver === 'official-codex') {
        assertExactKeys(value, common, ['label', 'identityFingerprint'], `account ${index}`);
    }
    else if (driver === 'api') {
        assertExactKeys(value, [...common, 'credentialEnv', 'routingDomain'], ['label'], `account ${index}`);
    }
    else {
        throw invalidError(`Account ${index} has an unsupported driver.`);
    }
    const provider = requireCanonicalProvider(value.provider);
    const accountId = requireCanonicalAccountId(value.accountId);
    const internalId = requireCanonicalUuid(value.internalId);
    const enabled = requireBoolean(value.enabled, `Account ${index} enabled`);
    const label = value.label === undefined ? undefined : requireCanonicalLabel(value.label);
    const createdAt = requireTimestamp(value.createdAt);
    const updatedAt = requireTimestamp(value.updatedAt);
    if (Date.parse(updatedAt) < Date.parse(createdAt))
        throw invalidError(`Account ${index} timestamps are inconsistent.`);
    if (driver === 'official-codex') {
        if (provider !== 'chatgpt')
            throw invalidError('Official Codex accounts must use the ChatGPT provider.');
        if (value.status !== 'pending' && value.status !== 'ready') {
            throw invalidError(`Account ${index} has an invalid Codex lifecycle status.`);
        }
        if (value.maxConcurrency !== 1)
            throw invalidError('Official Codex account concurrency must be one.');
        if (value.status === 'pending' && value.identityFingerprint !== undefined) {
            throw invalidError('Pending Codex accounts cannot have an identity fingerprint.');
        }
        if (value.status === 'ready' && value.identityFingerprint === undefined) {
            throw invalidError('Ready Codex accounts require an identity fingerprint.');
        }
        return {
            provider: 'chatgpt',
            accountId,
            internalId,
            driver: 'official-codex',
            status: value.status,
            enabled,
            maxConcurrency: 1,
            ...(label === undefined ? {} : { label }),
            ...(value.identityFingerprint === undefined
                ? {}
                : { identityFingerprint: requireCodexIdentityFingerprint(value.identityFingerprint) }),
            createdAt,
            updatedAt,
        };
    }
    if (value.status !== 'ready')
        throw invalidError('Public API accounts must be ready.');
    const maxConcurrency = boundedInteger(value.maxConcurrency, undefined, 1, MAX_API_CONCURRENCY, `Account ${index} max concurrency`);
    const routingDomain = requireCanonicalRoutingDomain(value.routingDomain);
    const credentialEnv = value.credentialEnv;
    if (credentialEnv !== apiCredentialEnvironmentName(provider, accountId)) {
        throw invalidError(`Account ${index} has a non-canonical credential environment name.`);
    }
    return {
        provider,
        accountId,
        internalId,
        driver: 'api',
        status: 'ready',
        enabled,
        maxConcurrency,
        ...(label === undefined ? {} : { label }),
        credentialEnv,
        routingDomain,
        createdAt,
        updatedAt,
    };
}
function validateBinding(value, index) {
    if (!isJsonRecord(value))
        throw invalidError(`Binding ${index} must be an object.`);
    assertExactKeys(value, [
        'projectId',
        'provider',
        'accountInternalId',
        'routingDomain',
        'failoverPolicy',
        'assignedBy',
        'generation',
        'createdAt',
        'updatedAt',
    ], [], `binding ${index}`);
    const createdAt = requireTimestamp(value.createdAt);
    const updatedAt = requireTimestamp(value.updatedAt);
    if (Date.parse(updatedAt) < Date.parse(createdAt))
        throw invalidError(`Binding ${index} timestamps are inconsistent.`);
    return {
        projectId: requireProjectId(value.projectId),
        provider: requireCanonicalProvider(value.provider),
        accountInternalId: requireCanonicalUuid(value.accountInternalId),
        routingDomain: value.routingDomain === null ? null : requireCanonicalRoutingDomain(value.routingDomain),
        failoverPolicy: requireFailoverPolicy(value.failoverPolicy),
        assignedBy: requireBindingAssignment(value.assignedBy),
        generation: boundedInteger(value.generation, undefined, 1, Number.MAX_SAFE_INTEGER, `Binding ${index} generation`),
        createdAt,
        updatedAt,
    };
}
function rejectSecretFields(value, location = 'registry') {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => rejectSecretFields(entry, `${location}[${index}]`));
        return;
    }
    if (!isJsonRecord(value))
        return;
    for (const [key, child] of Object.entries(value)) {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        const forbidden = new Set([
            'apikey',
            'accesskey',
            'accesstoken',
            'refreshtoken',
            'bearertoken',
            'token',
            'secret',
            'password',
            'cookie',
            'authorization',
            'authheader',
            'credential',
            'credentialvalue',
            'rawidentity',
            'email',
        ]);
        if (forbidden.has(normalized)) {
            throw new AccountPoolError('account_pool_secret_field_forbidden', `Secret-bearing field ${location}.${key} is forbidden in the account pool registry.`);
        }
        rejectSecretFields(child, `${location}.${key}`);
    }
}
function selectRendezvousAccount(candidates, projectId, provider, routingDomain) {
    let selected;
    let selectedScore;
    for (const candidate of candidates) {
        const hash = createHash('sha256');
        for (const value of [projectId, provider, routingDomain, candidate.internalId]) {
            const bytes = Buffer.from(value, 'utf8');
            const length = Buffer.allocUnsafe(4);
            length.writeUInt32BE(bytes.length);
            hash.update(length);
            hash.update(bytes);
        }
        const score = hash.digest();
        if (selectedScore === undefined ||
            Buffer.compare(score, selectedScore) > 0 ||
            (Buffer.compare(score, selectedScore) === 0 && candidate.internalId > (selected?.internalId ?? ''))) {
            selected = candidate;
            selectedScore = score;
        }
    }
    return selected;
}
function resolution(snapshotRevision, binding, account) {
    return {
        snapshotRevision,
        binding: cloneBinding(binding),
        account: cloneAccount(account),
    };
}
function findAccountBySlug(snapshot, provider, accountId) {
    return snapshot.accounts.find((account) => account.provider === provider && account.accountId === accountId);
}
function requireAccountBySlug(snapshot, provider, accountId) {
    const account = findAccountBySlug(snapshot, provider, accountId);
    if (account === undefined) {
        throw new AccountPoolError('account_pool_not_found', `Account ${provider}/${accountId} was not found.`);
    }
    return account;
}
function requireAccountByInternalId(snapshot, internalId) {
    const account = snapshot.accounts.find((candidate) => candidate.internalId === internalId);
    if (account === undefined)
        throw invalidError('Project binding references an unknown account.');
    return account;
}
function findBinding(snapshot, projectId, provider) {
    return snapshot.bindings.find((binding) => binding.projectId === projectId && binding.provider === provider);
}
function replaceAccount(snapshot, replacement) {
    snapshot.accounts = snapshot.accounts.map((account) => (account.internalId === replacement.internalId ? replacement : account));
}
function replaceBinding(snapshot, replacement) {
    const index = snapshot.bindings.findIndex((binding) => (binding.projectId === replacement.projectId && binding.provider === replacement.provider));
    if (index === -1)
        snapshot.bindings.push(replacement);
    else
        snapshot.bindings[index] = replacement;
}
function requireRoutableAccount(account) {
    if (account.status !== 'ready') {
        throw new AccountPoolError('account_pool_conflict', 'Pending accounts cannot receive project bindings.');
    }
    if (!account.enabled) {
        throw new AccountPoolError('account_pool_conflict', 'Disabled accounts cannot receive new project bindings.');
    }
}
function canonicalSnapshot(snapshot) {
    return {
        protocol: ACCOUNT_POOL_PROTOCOL,
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
        accounts: snapshot.accounts.map(cloneAccount).sort((left, right) => (left.provider.localeCompare(right.provider) || left.accountId.localeCompare(right.accountId))),
        bindings: snapshot.bindings.map(cloneBinding).sort((left, right) => (left.projectId.localeCompare(right.projectId) || left.provider.localeCompare(right.provider))),
    };
}
function mutableSnapshot(snapshot) {
    return {
        protocol: snapshot.protocol,
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
        accounts: snapshot.accounts.map(cloneAccount),
        bindings: snapshot.bindings.map(cloneBinding),
    };
}
function cloneSnapshot(snapshot) {
    return canonicalSnapshot(mutableSnapshot(snapshot));
}
function cloneAccount(account) {
    return { ...account };
}
function cloneBinding(binding) {
    return { ...binding };
}
function cloneValue(value) {
    return structuredClone(value);
}
function normalizeProvider(value) {
    if (typeof value !== 'string')
        throw invalidError('Provider must be a string.');
    const normalized = value.trim().toLowerCase();
    if (!PROVIDERS.includes(normalized))
        throw invalidError('Provider is unsupported.');
    return normalized;
}
function requireCanonicalProvider(value) {
    const provider = normalizeProvider(value);
    if (value !== provider)
        throw invalidError('Provider id is not canonical.');
    return provider;
}
function requireCanonicalAccountId(value) {
    const accountId = normalizeAccountId(value);
    if (value !== accountId)
        throw invalidError('Account id is not canonical.');
    return accountId;
}
function requireCanonicalRoutingDomain(value) {
    const routingDomain = normalizeRoutingDomain(value);
    if (value !== routingDomain)
        throw invalidError('Routing domain is not canonical.');
    return routingDomain;
}
function requireProjectId(value) {
    if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
        throw invalidError('Project id must be an exact 1-128 character URL-safe identifier.');
    }
    return value;
}
function requireCanonicalUuid(value) {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw invalidError('Internal account id must be a canonical lowercase UUIDv4.');
    }
    return value;
}
function requireCodexIdentityFingerprint(value) {
    if (typeof value !== 'string' || !CODEX_IDENTITY_FINGERPRINT_PATTERN.test(value)) {
        throw invalidError('Codex identity fingerprint has an invalid format.');
    }
    return value;
}
function normalizeOptionalLabel(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string')
        throw invalidError('Account label must be a string.');
    const normalized = value.trim();
    if (normalized.length < 1 ||
        normalized.length > MAX_LABEL_CHARACTERS ||
        /[\u0000-\u001f\u007f]/.test(normalized)) {
        throw invalidError(`Account label must be 1-${MAX_LABEL_CHARACTERS} printable characters.`);
    }
    return normalized;
}
function requireCanonicalLabel(value) {
    const label = normalizeOptionalLabel(value);
    if (value !== label || label === undefined)
        throw invalidError('Account label is not canonical.');
    return label;
}
function requireTimestamp(value) {
    if (typeof value !== 'string')
        throw invalidError('Timestamp must be a string.');
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
        throw invalidError('Timestamp must be a canonical ISO-8601 UTC timestamp.');
    }
    return value;
}
function requireBoolean(value, name) {
    if (typeof value !== 'boolean')
        throw invalidError(`${name} must be a boolean.`);
    return value;
}
function requireFailoverPolicy(value) {
    if (value !== 'availability-first' && value !== 'strict') {
        throw invalidError('Project failover policy is unsupported.');
    }
    return value;
}
function requireBindingAssignment(value) {
    if (value !== 'automatic' && value !== 'explicit' && value !== 'migration') {
        throw invalidError('Binding assignment type is unsupported.');
    }
    return value;
}
function boundedInteger(value, fallback, minimum, maximum, name) {
    const selected = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
        throw invalidError(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
    return selected;
}
function assertExactKeys(record, required, optional, name) {
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(record)) {
        if (!allowed.has(key))
            throw invalidError(`Unknown field ${name}.${key}.`);
    }
    for (const key of required) {
        if (!Object.hasOwn(record, key))
            throw invalidError(`Missing field ${name}.${key}.`);
    }
}
function isJsonRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isErrno(error, code) {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}
function invalidError(message) {
    return new AccountPoolError('account_pool_invalid', message);
}
//# sourceMappingURL=account-pool.js.map