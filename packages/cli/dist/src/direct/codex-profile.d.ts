import { DirectError } from './types.js';
export declare const CODEX_ACCOUNT_CREDENTIAL_STORE: 'file';
export declare const CODEX_IDENTITY_FINGERPRINT_VERSION: 'tokenless.codex-identity.v1';
export declare const CODEX_IDENTITY_KEY_BYTES = 32;
export type CodexAccountObservation = Readonly<{
    state: 'ready';
    fingerprint: string;
}> | Readonly<{
    state: 'unavailable';
    reason: 'no_account' | 'not_chatgpt';
}> | Readonly<{
    state: 'unverifiable';
    reason: 'identity_missing';
}>;
export type InspectCodexAccountOptions = Readonly<{
    executable: string;
    codexHome: string;
    identityKey: Buffer;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
}>;
export type TrustedCodexCommand = Readonly<{
    executable: string;
    argsPrefix: readonly string[];
    source: string;
}>;
export declare class CodexProfileError extends DirectError {
    readonly reason: string;
    constructor(reason: string, message: string, retryable?: boolean);
    toJSON(): {
        name: 'DirectError';
        code: import("./types.js").DirectErrorCode;
        message: string;
        retryable: boolean;
        status?: number | undefined;
        requestId?: string | undefined;
        reason: string;
    };
}
export declare function directAccountStateDir(homeDir: string): string;
export declare function codexIdentityKeyPath(homeDir: string): string;
export declare function managedCodexHome(homeDir: string, internalId: string): string;
export declare function createManagedCodexHome(homeDir: string, internalId: string): Promise<string>;
export declare function assertManagedCodexHome(codexHome: string): Promise<void>;
export declare function readOrCreateCodexIdentityKey(homeDir: string): Promise<Buffer>;
export declare function readCodexIdentityKey(homeDir: string): Promise<Buffer>;
export declare function fingerprintCodexIdentity(identity: string, identityKey: Buffer): string;
export declare function inspectCodexAccount(options: InspectCodexAccountOptions): Promise<CodexAccountObservation>;
export declare function resolveTrustedCodexExecutable(value?: string): Promise<string>;
export declare function resolveTrustedCodexCommand(value?: string): Promise<TrustedCodexCommand>;
//# sourceMappingURL=codex-profile.d.ts.map