export { DEFAULT_DAEMON_URL, MAX_NATIVE_MESSAGE_BYTES, cancelDaemonJob, claimNextDaemonJob, completeDaemonJob, createDaemonJob, daemonUrl, getDaemonJob, listDaemonJobs, readDaemonToken, waitDaemonJobResult, } from './daemon-client.js';
export type { ClaimNextDaemonJobOptions, CancelDaemonJobOptions, CompleteDaemonJobOptions, CreateDaemonJobOptions, DaemonClaimedJob, DaemonClientOptions, DaemonJob, GetDaemonJobOptions, ListDaemonJobsOptions, WaitDaemonJobResultOptions, } from './daemon-client.js';
export type { TokenlessConfig } from './job-store.js';
export { configPath, deriveTaskId, NATIVE_HOST_NAME, normalizeBrowserId, nativeMessagingHostDir, nativeMessagingHostDirs, readTokenlessConfig, TOKENLESS_CONFIG_PROTOCOL_VERSION, tokenlessHome, writeTokenlessConfig, } from './job-store.js';
export { DAEMON_LOG_FILE, DAEMON_PID_FILE, DAEMON_PROCESS_PROTOCOL, DAEMON_PROTOCOL, DAEMON_READY_PROOF_PROTOCOL, EXTENSION_BRIDGE_FILE, EXTENSION_BRIDGE_PROTOCOL, NATIVE_PROTOCOL, bundledRustBinaryPath, ensureDaemonReady, inspectNativeHostManifests, inspectRustBinaries, installNativeHost, installRustRuntime, installedRustBinaryPath, openProviderUrl, persistDaemonSnapshot, probeDaemonReady, providerWakeUrl, readLiveBridgeMarker, refreshInstalledRustBinaries, resolveChromiumBrowser, resolveDaemonBinary, waitForExtensionBridge, windowsNativeHostRegistryCommands, } from './runtime.js';
export { NATIVE_PLATFORM_PACKAGE_PROTOCOL, NATIVE_PLATFORM_PACKAGES, nativePlatformPackageName, resolveNativePlatformPackage, } from './platform-package.js';
export type { ResolveNativePlatformPackageOptions } from './platform-package.js';
export type { BridgeMarker, ChromiumBrowser, DaemonReadyProbe, EnsureDaemonOptions, InstallRustRuntimeOptions, } from './runtime.js';
export { executeDirectRun, resolveDirectBackend } from './direct/client.js';
export type { ExecuteDirectRunOptions } from './direct/client.js';
export { executeChatGptApi, MAX_DIRECT_REQUEST_BYTES } from './direct/api-client.js';
export type { ExecuteChatGptApiOptions } from './direct/api-client.js';
export { chatGptResponsesUrl, DEFAULT_DIRECT_CHATGPT_BASE_URL, DEFAULT_DIRECT_TIMEOUT_MS, MAX_DIRECT_TIMEOUT_MS, resolveDirectApiConfig, validateDirectBaseUrl, } from './direct/config.js';
export type { ResolvedDirectApiConfig, ResolveDirectApiConfigOptions, } from './direct/config.js';
export { DirectOfficialClientError, runOfficialCodex } from './direct/official-client.js';
export type { DirectOfficialClientErrorReason, OfficialCodexOptions, } from './direct/official-client.js';
export { DIRECT_PROTOCOL, DirectError } from './direct/types.js';
export type { DirectBackend, DirectCapability, DirectErrorCode, DirectErrorJson, DirectErrorOptions, DirectProtocol, DirectProvider, DirectRunRequest, DirectRunResult, DirectTransport, DirectUsage, } from './direct/types.js';
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