export { DEFAULT_DAEMON_URL, claimNextDaemonJob, completeDaemonJob, createDaemonJob, daemonUrl, getDaemonJob, readDaemonToken, waitDaemonJobResult, } from './daemon-client.js';
export type { ClaimNextDaemonJobOptions, CompleteDaemonJobOptions, CreateDaemonJobOptions, DaemonClaimedJob, DaemonClientOptions, DaemonJob, GetDaemonJobOptions, WaitDaemonJobResultOptions, } from './daemon-client.js';
export { buildTaskUrl, completeLocalJob, configPath, conversationMapPath, createLocalJob, deriveTaskId, ensureJobStore, installNativeHost, JOB_STATES, LOCAL_JOB_PROTOCOL_VERSION, NATIVE_HOST_NAME, normalizeBrowserId, nativeMessagingHostDir, nativeMessagingHostDirs, readConversationMap, readLocalHistory, readLocalJobRequest, readLocalTaskState, readTokenlessConfig, TOKENLESS_CONFIG_PROTOCOL_VERSION, tokenlessHome, upsertConversationMapping, waitLocalJobResult, writeDomSnapshot, writeTokenlessConfig, writeJobState, } from './job-store.js';
type TokenlessPromptOptions = {
    userPrompt?: string;
    projectRoot?: string;
    files?: string[];
    turnContext?: unknown;
    maxFileBytes?: number;
    maxTotalBytes?: number;
};
type CollectedFile = {
    path: string;
    truncated: boolean;
    text: string;
};
export declare function buildTokenlessPrompt({ userPrompt, projectRoot, files, turnContext, maxFileBytes, maxTotalBytes, }?: TokenlessPromptOptions): Promise<string>;
export declare function collectFiles(projectRoot: string, files: string[], maxFileBytes: number, maxTotalBytes: number): Promise<CollectedFile[]>;
//# sourceMappingURL=index.d.ts.map