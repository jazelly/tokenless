export declare const EXTENSION_BRIDGE_PROTOCOL = "tokenless.extension-bridge-state.v1";
export declare const DAEMON_PROTOCOL = "tokenless.daemon.v1";
export declare const NATIVE_PROTOCOL = "tokenless.native.v1";
export declare const DAEMON_PROCESS_PROTOCOL = "tokenless.daemon-process.v1";
export declare const DAEMON_READY_PROOF_PROTOCOL = "tokenless.daemon-ready-proof.v1";
export declare const EXTENSION_BRIDGE_FILE = "extension-bridge.json";
export declare const DAEMON_PID_FILE = "daemon.pid.json";
export declare const DAEMON_LOG_FILE = "daemon.log";
declare const DAEMON_BINARY_NAME = "tokenless-daemon";
declare const NATIVE_HOST_BINARY_NAME = "tokenless-native-host";
type JsonRecord = Record<string, any>;
export type DaemonReadyProbe = {
    ok: boolean;
    reachable: boolean;
    url: string;
    expectedHome: string;
    actualHome?: string | undefined;
    body?: JsonRecord | undefined;
    code?: string | undefined;
    message?: string | undefined;
};
export type ChromiumBrowser = {
    browser: string;
    command: string;
    argsPrefix: string[];
    displayName: string;
};
export type EnsureDaemonOptions = {
    homeDir?: string | undefined;
    daemonUrl?: string | undefined;
    binaryPath?: string | undefined;
    bundledRoot?: string | undefined;
    timeoutMs?: number | undefined;
};
export type BridgeMarker = {
    path: string;
    protocol: string;
    pid: number;
    sessionId: string;
    connectedAt: string;
    heartbeatAt: string;
    heartbeatAgeMs: number;
    raw: JsonRecord;
};
export type InstallRustRuntimeOptions = {
    homeDir?: string | undefined;
    manifestHome?: string | undefined;
    extensionId: string;
    browsers?: string[] | undefined;
    packageRoot?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    arch?: string | undefined;
    registerWindows?: boolean | undefined;
};
export declare function bundledRustBinaryPath(name: typeof DAEMON_BINARY_NAME | typeof NATIVE_HOST_BINARY_NAME, packageRoot?: string, platform?: NodeJS.Platform, arch?: string): string;
export declare function installedRustBinaryPath(homeDir?: string, name?: typeof DAEMON_BINARY_NAME | typeof NATIVE_HOST_BINARY_NAME, platform?: NodeJS.Platform): string;
export declare function resolveDaemonBinary({ homeDir, binaryPath, bundledRoot, }?: Pick<EnsureDaemonOptions, 'homeDir' | 'binaryPath' | 'bundledRoot'>): Promise<string>;
export declare function probeDaemonReady({ daemonUrl, homeDir, timeoutMs, daemonToken, }?: {
    daemonUrl?: string | undefined;
    homeDir?: string | undefined;
    timeoutMs?: number | undefined;
    daemonToken?: string | undefined;
}): Promise<DaemonReadyProbe>;
export declare function ensureDaemonReady({ homeDir, daemonUrl, binaryPath, bundledRoot, timeoutMs, }?: EnsureDaemonOptions): Promise<{
    ok: boolean;
    reachable: boolean;
    url: string;
    expectedHome: string;
    actualHome?: string | undefined;
    body?: JsonRecord | undefined;
    code?: string | undefined;
    message?: string | undefined;
    started: boolean;
    binaryPath: null;
    pid: number | null;
} | {
    ok: boolean;
    reachable: boolean;
    url: string;
    expectedHome: string;
    actualHome?: string | undefined;
    body?: JsonRecord | undefined;
    code?: string | undefined;
    message?: string | undefined;
    started: boolean;
    binaryPath: string;
    pid: number;
    logPath: string;
}>;
export declare function readLiveBridgeMarker({ homeDir, maxAgeMs, }?: {
    homeDir?: string | undefined;
    maxAgeMs?: number | undefined;
}): Promise<BridgeMarker | null>;
export declare function waitForExtensionBridge({ homeDir, timeoutMs, pollMs, }?: {
    homeDir?: string | undefined;
    timeoutMs?: number | undefined;
    pollMs?: number | undefined;
}): Promise<BridgeMarker>;
export declare function providerWakeUrl(provider: unknown, targetUrl?: unknown): string;
export declare function resolveChromiumBrowser(requested?: unknown): Promise<ChromiumBrowser>;
export declare function openProviderUrl(url: string, browser: ChromiumBrowser): Promise<void>;
export declare function installRustRuntime({ homeDir, manifestHome, extensionId, browsers, packageRoot, platform, arch, registerWindows, }: InstallRustRuntimeOptions): Promise<{
    runtime: string;
    daemonExecutable: string;
    nativeHostExecutable: string;
    manifests: string[];
    registryCommands: string[][];
    allowedOrigin: string | undefined;
}>;
export declare const installNativeHost: typeof installRustRuntime;
export declare function windowsNativeHostRegistryCommands({ manifestPath, browsers, }: {
    manifestPath: string;
    browsers: string[];
}): string[][];
export declare function inspectNativeHostManifests({ homeDir, manifestHome, browsers, platform, }?: {
    homeDir?: string | undefined;
    manifestHome?: string | undefined;
    browsers?: string[] | undefined;
    platform?: NodeJS.Platform | undefined;
}): Promise<{
    ok: boolean;
    candidates: string[];
    manifests: {
        path: string;
        ok: boolean;
        manifest: JsonRecord;
    }[];
}>;
export declare function inspectRustBinaries(homeDir?: string): Promise<{
    ok: boolean;
    package: {
        ok: boolean;
        error: string | null;
    };
    daemon: {
        ok: boolean;
        path: string;
        hash: string | null;
        bundledHash: string | null;
        matchesBundled: boolean;
    };
    nativeHost: {
        ok: boolean;
        path: string;
        hash: string | null;
        bundledHash: string | null;
        matchesBundled: boolean;
    };
}>;
export declare function refreshInstalledRustBinaries({ homeDir, packageRoot, }?: {
    homeDir?: string | undefined;
    packageRoot?: string | undefined;
}): Promise<string[]>;
export declare function persistDaemonSnapshot({ homeDir, jobId, provider, result, }: {
    homeDir?: string | undefined;
    jobId: string;
    provider: string;
    result: unknown;
}): Promise<{
    protocol: string;
    jobId: string;
    provider: any;
    action: string;
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
export {};
//# sourceMappingURL=runtime.d.ts.map