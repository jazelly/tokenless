export { DEFAULT_DAEMON_URL, MAX_NATIVE_MESSAGE_BYTES, cancelDaemonJob, claimNextDaemonJob, completeDaemonJob, createDaemonJob, daemonUrl, getDaemonJob, listDaemonJobs, readDaemonToken, waitDaemonJobResult, } from './daemon-client.js';
export type { ClaimNextDaemonJobOptions, CancelDaemonJobOptions, CompleteDaemonJobOptions, CreateDaemonJobOptions, DaemonClaimedJob, DaemonClientOptions, DaemonJob, GetDaemonJobOptions, ListDaemonJobsOptions, WaitDaemonJobResultOptions, } from './daemon-client.js';
export type { TokenlessConfig } from './job-store.js';
export { configPath, deriveTaskId, NATIVE_HOST_NAME, normalizeBrowserId, nativeMessagingHostDir, nativeMessagingHostDirs, readTokenlessConfig, TOKENLESS_CONFIG_PROTOCOL_VERSION, tokenlessHome, writeTokenlessConfig, } from './job-store.js';
export { DAEMON_LOG_FILE, DAEMON_PID_FILE, DAEMON_PROCESS_PROTOCOL, DAEMON_PROTOCOL, DAEMON_READY_PROOF_PROTOCOL, EXTENSION_BRIDGE_FILE, EXTENSION_BRIDGE_PROTOCOL, NATIVE_PROTOCOL, bundledRustBinaryPath, ensureDaemonReady, inspectNativeHostManifests, inspectRustBinaries, installNativeHost, installRustRuntime, installedRustBinaryPath, openProviderUrl, persistDaemonSnapshot, probeDaemonReady, providerWakeUrl, readLiveBridgeMarker, refreshInstalledRustBinaries, resolveChromiumBrowser, resolveDaemonBinary, waitForExtensionBridge, windowsNativeHostRegistryCommands, } from './runtime.js';
export { NATIVE_PLATFORM_PACKAGE_PROTOCOL, NATIVE_PLATFORM_PACKAGES, nativePlatformPackageName, resolveNativePlatformPackage, } from './platform-package.js';
export type { ResolveNativePlatformPackageOptions } from './platform-package.js';
export type { BridgeMarker, ChromiumBrowser, DaemonReadyProbe, EnsureDaemonOptions, InstallRustRuntimeOptions, } from './runtime.js';
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