import type { DirectProvider } from './types.js';
export declare const ACCOUNT_POOL_PROTOCOL: 'tokenless.account-pool.v1';
export type AccountPoolProtocol = typeof ACCOUNT_POOL_PROTOCOL;
export type AccountStatus = 'pending' | 'ready';
export type ProjectFailoverPolicy = 'availability-first' | 'strict';
export type BindingAssignment = 'automatic' | 'explicit' | 'migration';
type AccountRecordBase = Readonly<{
    provider: DirectProvider;
    accountId: string;
    internalId: string;
    enabled: boolean;
    maxConcurrency: number;
    label?: string | undefined;
    createdAt: string;
    updatedAt: string;
}>;
export type CodexAccountRecord = AccountRecordBase & Readonly<{
    provider: 'chatgpt';
    driver: 'official-codex';
    status: AccountStatus;
    identityFingerprint?: string | undefined;
}>;
export type ApiAccountRecord = AccountRecordBase & Readonly<{
    driver: 'api';
    status: 'ready';
    credentialEnv: string;
    routingDomain: string;
}>;
export type AccountRecord = CodexAccountRecord | ApiAccountRecord;
export type ProjectBinding = Readonly<{
    projectId: string;
    provider: DirectProvider;
    accountInternalId: string;
    routingDomain: string | null;
    failoverPolicy: ProjectFailoverPolicy;
    assignedBy: BindingAssignment;
    generation: number;
    createdAt: string;
    updatedAt: string;
}>;
export type AccountPoolSnapshot = Readonly<{
    protocol: AccountPoolProtocol;
    revision: number;
    updatedAt: string | null;
    accounts: AccountRecord[];
    bindings: ProjectBinding[];
}>;
export type AccountResolution = Readonly<{
    snapshotRevision: number;
    binding: ProjectBinding;
    account: AccountRecord;
}>;
export type MigrationResult = Readonly<{
    migrated: boolean;
    resolution: AccountResolution;
}>;
export type AddCodexAccountInput = Readonly<{
    provider: 'chatgpt';
    accountId: string;
    driver: 'official-codex';
    enabled?: boolean | undefined;
    label?: string | undefined;
}>;
export type AddApiAccountInput = Readonly<{
    provider: DirectProvider;
    accountId: string;
    driver: 'api';
    routingDomain: string;
    enabled?: boolean | undefined;
    maxConcurrency?: number | undefined;
    label?: string | undefined;
}>;
export type AddAccountInput = AddCodexAccountInput | AddApiAccountInput;
export type AccountReference = Readonly<{
    provider: DirectProvider | string;
    accountId: string;
}>;
export type ProjectReference = Readonly<{
    projectId: string;
    provider: DirectProvider | string;
}>;
export type AccountPoolSerialization = <T>(stateFile: string, operation: () => Promise<T>) => Promise<T>;
export type AccountPoolStoreOptions = Readonly<{
    homeDir?: string | undefined;
    now?: (() => Date) | undefined;
    randomUUID?: (() => string) | undefined;
    serialize?: AccountPoolSerialization | undefined;
}>;
export type AccountPoolErrorCode = 'account_pool_already_exists' | 'account_pool_bound_account' | 'account_pool_conflict' | 'account_pool_invalid' | 'account_pool_no_eligible_account' | 'account_pool_not_found' | 'account_pool_permission_denied' | 'account_pool_routing_domain_mismatch' | 'account_pool_secret_field_forbidden' | 'account_pool_unreadable' | 'account_pool_unsupported_protocol';
export declare class AccountPoolError extends Error {
    readonly code: AccountPoolErrorCode;
    readonly retryable = false;
    constructor(code: AccountPoolErrorCode, message: string);
}
/**
 * Serializes registry read-modify-write operations across store instances in this
 * process. Production wraps this seam with a caller-owned cross-process lock
 * without changing the registry mutation contract.
 */
export declare function withProcessLocalAccountPoolSerialization<T>(stateFile: string, operation: () => Promise<T>): Promise<T>;
export declare function accountPoolDirectDirectory(homeDir?: string): string;
export declare function accountPoolStatePath(homeDir?: string): string;
export declare function accountPoolProfilePath(homeDir: string, provider: DirectProvider | string, internalId: string): string;
export declare function accountPoolAccountLockPath(homeDir: string, provider: DirectProvider | string, internalId: string): string;
export declare function normalizeAccountId(value: unknown): string;
export declare function normalizeRoutingDomain(value: unknown): string;
export declare function apiCredentialEnvironmentName(provider: DirectProvider | string, accountId: string): string;
export declare class AccountPoolStore {
    #private;
    readonly homeDir: string;
    readonly stateFile: string;
    constructor(options?: AccountPoolStoreOptions);
    readSnapshot(): Promise<AccountPoolSnapshot>;
    listAccounts(filter?: {
        provider?: DirectProvider | string | undefined;
    }): Promise<AccountRecord[]>;
    listBindings(filter?: {
        projectId?: string | undefined;
        provider?: DirectProvider | string | undefined;
    }): Promise<Readonly<{
        projectId: string;
        provider: DirectProvider;
        accountInternalId: string;
        routingDomain: string | null;
        failoverPolicy: ProjectFailoverPolicy;
        assignedBy: BindingAssignment;
        generation: number;
        createdAt: string;
        updatedAt: string;
    }>[]>;
    addCodexAccount(input: Omit<AddCodexAccountInput, 'driver' | 'provider'> & {
        provider?: 'chatgpt' | undefined;
    }): Promise<CodexAccountRecord>;
    addApiAccount(input: Omit<AddApiAccountInput, 'driver'>): Promise<ApiAccountRecord>;
    addAccount(input: AddCodexAccountInput): Promise<CodexAccountRecord>;
    addAccount(input: AddApiAccountInput): Promise<ApiAccountRecord>;
    addAccount(input: AddAccountInput): Promise<AccountRecord>;
    finalizeCodexIdentity(input: AccountReference & {
        expectedInternalId: string;
        identityFingerprint: string;
    }): Promise<CodexAccountRecord>;
    enableAccount(reference: AccountReference): Promise<AccountRecord>;
    disableAccount(reference: AccountReference): Promise<AccountRecord>;
    removeAccount(reference: AccountReference): Promise<AccountRecord>;
    pinProject(input: ProjectReference & {
        accountId: string;
        failoverPolicy?: ProjectFailoverPolicy | undefined;
    }): Promise<AccountResolution>;
    unpinProject(reference: ProjectReference): Promise<ProjectBinding | null>;
    resolve(reference: ProjectReference): Promise<AccountResolution | null>;
    resolveOrAssign(input: ProjectReference & {
        routingDomain: string;
        failoverPolicy?: ProjectFailoverPolicy | undefined;
    }): Promise<AccountResolution>;
    migrateIfCurrent(input: ProjectReference & {
        expectedAccountInternalId: string;
        expectedGeneration: number;
        nextAccountInternalId: string;
    }): Promise<MigrationResult>;
}
export {};
//# sourceMappingURL=account-pool.d.ts.map