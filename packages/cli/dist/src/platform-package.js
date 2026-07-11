import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const NATIVE_PLATFORM_PACKAGE_PROTOCOL = 'tokenless.native-package.v1';
export const NATIVE_PLATFORM_PACKAGES = Object.freeze({
    'darwin-arm64': 'tokenless-native-darwin-arm64',
    'darwin-x64': 'tokenless-native-darwin-x64',
    'linux-arm64': 'tokenless-native-linux-arm64',
    'linux-x64': 'tokenless-native-linux-x64',
    'win32-arm64': 'tokenless-native-win32-arm64',
    'win32-x64': 'tokenless-native-win32-x64',
});
export function nativePlatformPackageName(platform = process.platform, arch = process.arch) {
    const tuple = `${platform}-${arch}`;
    const packageName = NATIVE_PLATFORM_PACKAGES[tuple];
    if (packageName)
        return packageName;
    throw platformPackageError('unsupported_native_platform', `Tokenless has no native runtime for ${platform}-${arch}. Supported platforms: ${Object.keys(NATIVE_PLATFORM_PACKAGES).join(', ')}.`);
}
export function resolveNativePlatformPackage({ platform = process.platform, arch = process.arch, expectedVersion = tokenlessPackageVersion(), resolvePackageJson = defaultResolvePackageJson, } = {}) {
    const packageName = nativePlatformPackageName(platform, arch);
    let manifestPath;
    try {
        manifestPath = resolvePackageJson(packageName);
    }
    catch {
        throw platformPackageError('native_platform_package_missing', `The optional native runtime ${packageName}@${expectedVersion} is not installed. Reinstall tokenless with optional dependencies enabled. Tokenless never downloads executables at runtime.`);
    }
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
    catch {
        throw platformPackageError('native_platform_package_invalid', `Cannot read the installed native runtime manifest at ${manifestPath}. Reinstall tokenless.`);
    }
    const runtime = manifest.tokenlessRuntime;
    const valid = manifest.name === packageName &&
        manifest.version === expectedVersion &&
        Array.isArray(manifest.os) && manifest.os.length === 1 && manifest.os[0] === platform &&
        Array.isArray(manifest.cpu) && manifest.cpu.length === 1 && manifest.cpu[0] === arch &&
        runtime?.protocol === NATIVE_PLATFORM_PACKAGE_PROTOCOL &&
        runtime.platform === platform &&
        runtime.arch === arch;
    if (!valid) {
        throw platformPackageError('native_platform_package_invalid', `Native runtime ${packageName} does not match tokenless@${expectedVersion} for ${platform}-${arch}. Reinstall tokenless.`);
    }
    return {
        name: packageName,
        version: expectedVersion,
        platform,
        arch,
        root: path.dirname(manifestPath),
        manifestPath,
    };
}
function defaultResolvePackageJson(packageName) {
    const require = createRequire(import.meta.url);
    try {
        return require.resolve(`${packageName}/package.json`);
    }
    catch (error) {
        // Source builds stage the current native package outside the universal
        // package. This directory is excluded from the published tokenless tarball.
        const developmentPath = path.join(cliPackageRoot(), 'npm', packageName, 'package.json');
        if (fs.existsSync(developmentPath))
            return developmentPath;
        throw error;
    }
}
function tokenlessPackageVersion() {
    const manifestPath = path.join(cliPackageRoot(), 'package.json');
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (typeof manifest.version === 'string' && manifest.version)
            return manifest.version;
    }
    catch {
        // The deterministic error below is more useful than a JSON parser error.
    }
    throw platformPackageError('tokenless_package_invalid', `Cannot read the tokenless package version at ${manifestPath}. Reinstall tokenless.`);
}
function cliPackageRoot() {
    return path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
}
function platformPackageError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.retryable = false;
    return error;
}
//# sourceMappingURL=platform-package.js.map