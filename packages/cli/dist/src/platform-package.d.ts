export declare const NATIVE_PLATFORM_PACKAGE_PROTOCOL = "tokenless.native-package.v1";
export declare const NATIVE_PLATFORM_PACKAGES: Readonly<{
    readonly 'darwin-arm64': 'tokenless-native-darwin-arm64';
    readonly 'darwin-x64': 'tokenless-native-darwin-x64';
    readonly 'linux-arm64': 'tokenless-native-linux-arm64';
    readonly 'linux-x64': 'tokenless-native-linux-x64';
    readonly 'win32-arm64': 'tokenless-native-win32-arm64';
    readonly 'win32-x64': 'tokenless-native-win32-x64';
}>;
export type ResolveNativePlatformPackageOptions = {
    platform?: NodeJS.Platform | undefined;
    arch?: string | undefined;
    expectedVersion?: string | undefined;
    resolvePackageJson?: ((packageName: string) => string) | undefined;
};
export declare function nativePlatformPackageName(platform?: NodeJS.Platform, arch?: string): "tokenless-native-darwin-arm64" | "tokenless-native-darwin-x64" | "tokenless-native-linux-arm64" | "tokenless-native-linux-x64" | "tokenless-native-win32-arm64" | "tokenless-native-win32-x64";
export declare function resolveNativePlatformPackage({ platform, arch, expectedVersion, resolvePackageJson, }?: ResolveNativePlatformPackageOptions): {
    name: "tokenless-native-darwin-arm64" | "tokenless-native-darwin-x64" | "tokenless-native-linux-arm64" | "tokenless-native-linux-x64" | "tokenless-native-win32-arm64" | "tokenless-native-win32-x64";
    version: string;
    platform: NodeJS.Platform;
    arch: string;
    root: string;
    manifestPath: string;
};
//# sourceMappingURL=platform-package.d.ts.map