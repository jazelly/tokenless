export declare const LOCAL_JOB_PROTOCOL_VERSION = "tokenless.local-job.v1";
export declare const CONVERSATION_MAP_PROTOCOL_VERSION = "tokenless.conversation-map.v1";
export declare const TOKENLESS_CONFIG_PROTOCOL_VERSION = "tokenless.config.v1";
export declare const NATIVE_HOST_NAME = "dev.tokenless.native_host";
export declare const JOB_STATES: Readonly<{
    QUEUED: "queued";
    CLAIMED: "claimed";
    RUNNING: "running";
    NEEDS_USER: "needs_user";
    BLOCKED: "blocked";
    UI_MISMATCH: "ui_mismatch";
    SUCCEEDED: "succeeded";
    FAILED: "failed";
    CANCELED: "canceled";
    TIMED_OUT: "timed_out";
}>;
export declare const SUPPORTED_BROWSER_IDS: readonly string[];
type JsonRecord = Record<string, any>;
export declare function tokenlessHome(explicitHome?: string | undefined): string;
export declare function normalizeBrowserId(browser: unknown): string | null;
export declare function jobsDir(homeDir?: string): string;
export declare function metaDir(homeDir?: string): string;
export declare function snapshotsDir(homeDir?: string): string;
export declare function conversationMapPath(homeDir?: string): string;
export declare function configPath(homeDir?: string): string;
export declare function createJobId(): `${string}-${string}-${string}-${string}-${string}`;
export declare function createNonce(): string;
export declare function deriveTaskId({ projectName, chatName, idempotencyKey }?: JsonRecord): string | undefined;
export declare function ensureJobStore(homeDir?: string): Promise<void>;
export declare function createLocalJob({ homeDir, provider, action, prompt, projectRoot, projectName, chatName, targetUrl, idempotencyKey, readDelayMs, readTimeoutMs, metadata, includeText, maxTextChars, ttlMs, }?: JsonRecord): Promise<{
    protocol: string;
    jobId: `${string}-${string}-${string}-${string}-${string}`;
    nonce: string;
    status: "queued";
    createdAt: string;
    expiresAt: string;
    provider: any;
    action: any;
    prompt: any;
    projectRoot: string | undefined;
    projectName: string | undefined;
    chatName: string | undefined;
    taskId: string | undefined;
    targetUrl: any;
    idempotencyKey: string | undefined;
    conversation: {
        idempotencyKey: undefined;
        route: string;
        targetUrl: any;
        mappedAt?: never;
        providerConversationId?: never;
    } | {
        idempotencyKey: string;
        route: string;
        targetUrl: any;
        mappedAt: any;
        providerConversationId: any;
    } | {
        mappedAt?: never;
        providerConversationId?: never;
        idempotencyKey: string;
        route: string;
        targetUrl: any;
    };
    readDelayMs: any;
    readTimeoutMs: any;
    includeText: any;
    maxTextChars: any;
    metadata: any;
}>;
export declare function readLocalTaskState({ homeDir, taskId, jobId, provider, projectName, chatName, limit, }?: JsonRecord): Promise<{
    protocol: string;
    taskId: any;
    provider: any;
    latest: JsonRecord;
    jobs: JsonRecord[];
    conversation: any;
}>;
export declare function readLocalJobRequest({ homeDir, jobId, nonce }?: JsonRecord): Promise<JsonRecord>;
export declare function writeDomSnapshot({ homeDir, jobId, nonce, provider, snapshot, }?: JsonRecord): Promise<{
    protocol: string;
    jobId: any;
    provider: any;
    action: any;
    capturedAt: any;
    url: any;
    title: any;
    sanitized: boolean;
    includeText: boolean;
    htmlPath: string;
    selectorProbesPath: string;
    visibleTextPath: string | null;
    snapshotDir: string;
    metadataPath: string;
}>;
export declare function writeJobState({ homeDir, jobId, nonce, status, actor, detail, }?: JsonRecord): Promise<{
    protocol: string;
    jobId: any;
    nonce: any;
    status: any;
    actor: any;
    detail: any;
    updatedAt: string;
}>;
export declare function completeLocalJob({ homeDir, jobId, nonce, ok, result, error, actor, }?: JsonRecord): Promise<{
    protocol: string;
    jobId: any;
    nonce: any;
    requestId: any;
    ok: boolean;
    provider: any;
    action: any;
    status: "blocked" | "failed" | "succeeded" | "timed_out" | "ui_mismatch";
    completedAt: string;
    compactOutput: any;
    result: any;
    error: {
        code: string;
        message: string;
        retryable: boolean;
    } | null;
}>;
export declare function readConversationMap(homeDir?: string): Promise<JsonRecord>;
export declare function readTokenlessConfig(homeDir?: string): Promise<JsonRecord>;
export declare function writeTokenlessConfig({ homeDir, preferredProviders, browser, }?: JsonRecord): Promise<{
    protocol: string;
    updatedAt: string;
    preferredProviders: string[];
    browser: string | null;
}>;
export declare function upsertConversationMapping({ homeDir, provider, idempotencyKey, targetUrl, jobId, projectName, chatName, projectRoot, }?: JsonRecord): Promise<any>;
export declare function readLocalHistory({ homeDir, limit }?: JsonRecord): Promise<{
    protocol: string;
    updatedAt: string;
    history: JsonRecord[];
}>;
export declare function waitLocalJobResult({ homeDir, jobId, nonce, timeoutMs, pollMs, statusIntervalMs, onStatus, }?: JsonRecord): Promise<JsonRecord>;
export declare function installNativeHost({ homeDir, manifestHome, extensionId, browsers, nodePath, packageRoot, }?: JsonRecord): Promise<{
    executable: string;
    manifests: string[];
}>;
export declare function nativeMessagingHostDir(browser: string, home?: string): string | null;
export declare function nativeMessagingHostDirs(browser: string, home?: string): string[];
export declare function buildTaskUrl({ extensionId, jobId, nonce }?: JsonRecord): string;
export declare function jobPath(homeDir: string, jobId: string, kind: string): string;
export {};
//# sourceMappingURL=job-store.d.ts.map