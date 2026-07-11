export declare const TOKENLESS_CONFIG_PROTOCOL_VERSION = "tokenless.config.v1";
export declare const NATIVE_HOST_NAME = "dev.tokenless.native_host";
export declare const SUPPORTED_BROWSER_IDS: readonly string[];
export type TokenlessConfig = {
    protocol: typeof TOKENLESS_CONFIG_PROTOCOL_VERSION;
    updatedAt: string | null;
    preferredProviders: string[];
    browser: string | null;
    daemonUrl: string | null;
};
export declare function tokenlessHome(explicitHome?: string | undefined): string;
export declare function configPath(homeDir?: string): string;
export declare function snapshotsDir(homeDir?: string): string;
export declare function normalizeBrowserId(browser: unknown): string | null;
export declare function deriveTaskId({ projectName, chatName, idempotencyKey, }?: {
    projectName?: unknown;
    chatName?: unknown;
    idempotencyKey?: unknown;
}): string | undefined;
export declare function readTokenlessConfig(homeDir?: string): Promise<TokenlessConfig>;
export declare function writeTokenlessConfig({ homeDir, preferredProviders, browser, daemonUrl, }?: {
    homeDir?: string;
    preferredProviders?: unknown;
    browser?: unknown;
    daemonUrl?: unknown;
}): Promise<TokenlessConfig>;
export declare function nativeMessagingHostDir(browser: string, home?: string, platform?: NodeJS.Platform): string | null;
export declare function nativeMessagingHostDirs(browser: string, home?: string, platform?: NodeJS.Platform): string[];
//# sourceMappingURL=job-store.d.ts.map