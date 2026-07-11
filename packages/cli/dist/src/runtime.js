import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_HOST_NAME, nativeMessagingHostDirs, normalizeBrowserId, snapshotsDir, tokenlessHome, } from './job-store.js';
import { daemonUrl as normalizeDaemonUrl, readDaemonToken } from './daemon-client.js';
import { resolveNativePlatformPackage } from './platform-package.js';
export const EXTENSION_BRIDGE_PROTOCOL = 'tokenless.extension-bridge-state.v1';
export const DAEMON_PROTOCOL = 'tokenless.daemon.v1';
export const NATIVE_PROTOCOL = 'tokenless.native.v1';
export const DAEMON_PROCESS_PROTOCOL = 'tokenless.daemon-process.v1';
export const DAEMON_READY_PROOF_PROTOCOL = 'tokenless.daemon-ready-proof.v1';
export const EXTENSION_BRIDGE_FILE = 'extension-bridge.json';
export const DAEMON_PID_FILE = 'daemon.pid.json';
export const DAEMON_LOG_FILE = 'daemon.log';
const DAEMON_BINARY_NAME = 'tokenless-daemon';
const NATIVE_HOST_BINARY_NAME = 'tokenless-native-host';
const DEFAULT_BRIDGE_MAX_AGE_MS = 15_000;
const BRIDGE_CLOCK_TOLERANCE_MS = 5_000;
const DEFAULT_DAEMON_START_TIMEOUT_MS = 10_000;
const SUPPORTED_PROVIDERS = new Set(['chatgpt', 'claude', 'gemini']);
export function bundledRustBinaryPath(name, packageRoot, platform = process.platform, arch = process.arch) {
    const nativeRoot = packageRoot ?? resolveNativePlatformPackage({ platform, arch }).root;
    return path.join(nativeRoot, 'bin', executableName(name, platform));
}
export function installedRustBinaryPath(homeDir = tokenlessHome(), name = DAEMON_BINARY_NAME, platform = process.platform) {
    return path.join(homeDir, 'bin', executableName(name, platform));
}
export async function resolveDaemonBinary({ homeDir = tokenlessHome(), binaryPath, bundledRoot, } = {}) {
    const candidates = [
        binaryPath,
        installedRustBinaryPath(homeDir, DAEMON_BINARY_NAME),
    ].filter((candidate) => Boolean(candidate));
    for (const candidate of candidates) {
        if (await isExecutable(candidate))
            return path.resolve(candidate);
    }
    let bundledError;
    try {
        const bundled = bundledRustBinaryPath(DAEMON_BINARY_NAME, bundledRoot);
        candidates.push(bundled);
        if (await isExecutable(bundled))
            return path.resolve(bundled);
    }
    catch (error) {
        bundledError = error;
    }
    throw runtimeError('daemon_binary_missing', `Tokenless Rust daemon is not installed. Reinstall tokenless with optional dependencies enabled, then run "tokenless install". Checked: ${candidates.join(', ')}${bundledError instanceof Error ? `. ${bundledError.message}` : ''}`, false);
}
export async function probeDaemonReady({ daemonUrl, homeDir = tokenlessHome(), timeoutMs = 750, daemonToken, } = {}) {
    const url = normalizeDaemonUrl(daemonUrl);
    const expectedHome = await canonicalPath(homeDir);
    let proofToken = daemonToken;
    try {
        proofToken ??= await readDaemonToken({ homeDir });
    }
    catch (error) {
        return {
            ok: false,
            reachable: false,
            url,
            expectedHome,
            code: 'daemon_token_unavailable',
            message: error instanceof Error ? error.message : 'Tokenless daemon token is unavailable.',
        };
    }
    const readyChallenge = randomBytes(32).toString('base64url');
    let response;
    try {
        const query = new URLSearchParams({ challenge: readyChallenge });
        response = await fetch(`${url}/ready?${query.toString()}`, { signal: AbortSignal.timeout(timeoutMs) });
    }
    catch {
        return {
            ok: false,
            reachable: false,
            url,
            expectedHome,
            code: 'daemon_unavailable',
            message: 'Tokenless daemon is not reachable.',
        };
    }
    let body;
    try {
        body = await response.json();
    }
    catch {
        return {
            ok: false,
            reachable: true,
            url,
            expectedHome,
            code: 'daemon_invalid_ready',
            message: 'Tokenless daemon /ready returned invalid JSON.',
        };
    }
    if (!response.ok || body?.ready !== true) {
        return {
            ok: false,
            reachable: true,
            url,
            expectedHome,
            body,
            code: 'daemon_not_ready',
            message: `Tokenless daemon /ready returned HTTP ${response.status} without ready=true.`,
        };
    }
    const proofError = validateDaemonReadyProof(body, readyChallenge, proofToken);
    if (proofError) {
        return {
            ok: false,
            reachable: true,
            url,
            expectedHome,
            body,
            code: proofError.code,
            message: proofError.message,
        };
    }
    if (body.daemon_protocol !== DAEMON_PROTOCOL) {
        return {
            ok: false,
            reachable: true,
            url,
            expectedHome,
            body,
            code: 'daemon_protocol_mismatch',
            message: `Tokenless daemon protocol is ${String(body.daemon_protocol ?? 'missing')}; expected ${DAEMON_PROTOCOL}. Reinstall Tokenless before running jobs.`,
        };
    }
    if (body.native_protocol !== NATIVE_PROTOCOL) {
        return {
            ok: false,
            reachable: true,
            url,
            expectedHome,
            body,
            code: 'native_protocol_mismatch',
            message: `Tokenless native protocol is ${String(body.native_protocol ?? 'missing')}; expected ${NATIVE_PROTOCOL}. Reinstall Tokenless before running jobs.`,
        };
    }
    const readyHome = readyHomeFromBody(body);
    if (!readyHome) {
        return {
            ok: false,
            reachable: true,
            url,
            expectedHome,
            body,
            code: 'daemon_identity_missing',
            message: 'Tokenless daemon /ready did not identify its home directory.',
        };
    }
    const actualHome = await canonicalPath(readyHome);
    if (actualHome !== expectedHome) {
        return {
            ok: false,
            reachable: true,
            url,
            expectedHome,
            actualHome,
            body,
            code: 'daemon_home_mismatch',
            message: `Daemon at ${url} uses ${actualHome}, not requested Tokenless home ${expectedHome}.`,
        };
    }
    return { ok: true, reachable: true, url, expectedHome, actualHome, body };
}
export async function ensureDaemonReady({ homeDir = tokenlessHome(), daemonUrl, binaryPath, bundledRoot, timeoutMs = envNumber('TOKENLESS_DAEMON_START_TIMEOUT_MS', DEFAULT_DAEMON_START_TIMEOUT_MS), } = {}) {
    await fs.mkdir(homeDir, { recursive: true, mode: 0o700 });
    const initial = await probeDaemonReady({ daemonUrl, homeDir });
    if (initial.ok)
        return { ...initial, started: false, binaryPath: null, pid: await readDaemonPid(homeDir) };
    assertNoDaemonIdentityConflict(initial);
    const releaseLock = await acquireDaemonStartLock({ homeDir, timeoutMs });
    try {
        const afterLock = await probeDaemonReady({ daemonUrl, homeDir });
        if (afterLock.ok) {
            return { ...afterLock, started: false, binaryPath: null, pid: await readDaemonPid(homeDir) };
        }
        assertNoDaemonIdentityConflict(afterLock);
        if (!binaryPath)
            await refreshInstalledRustBinaries({ homeDir, packageRoot: bundledRoot }).catch(() => undefined);
        const executable = await resolveDaemonBinary({ homeDir, binaryPath, bundledRoot });
        const parsedUrl = new URL(normalizeDaemonUrl(daemonUrl));
        const host = daemonBindHost(parsedUrl.hostname);
        const port = parsedUrl.port ? Number(parsedUrl.port) : 80;
        const logPath = path.join(homeDir, DAEMON_LOG_FILE);
        const child = await spawnDaemon({ executable, homeDir, host, port, logPath });
        const pidPayload = {
            protocol: DAEMON_PROCESS_PROTOCOL,
            pid: child.pid,
            homeDir: await canonicalPath(homeDir),
            daemonUrl: parsedUrl.origin,
            binaryPath: executable,
            logPath,
            startedAt: new Date().toISOString(),
        };
        await writeJsonAtomic(path.join(homeDir, DAEMON_PID_FILE), pidPayload, 0o600);
        const deadline = Date.now() + timeoutMs;
        let lastProbe = afterLock;
        while (Date.now() < deadline) {
            lastProbe = await probeDaemonReady({ daemonUrl, homeDir });
            if (lastProbe.ok) {
                child.unref();
                return {
                    ...lastProbe,
                    started: true,
                    binaryPath: executable,
                    pid: child.pid,
                    logPath,
                };
            }
            assertNoDaemonIdentityConflict(lastProbe);
            if (child.exitCode !== null)
                break;
            await delay(100);
        }
        if (child.exitCode === null)
            child.kill('SIGTERM');
        await removePidIfOwned(homeDir, child.pid);
        throw runtimeError('daemon_start_failed', `Tokenless Rust daemon did not become ready for ${homeDir}. See ${logPath}. Last check: ${lastProbe.message ?? lastProbe.code ?? 'unknown error'}`, true);
    }
    finally {
        await releaseLock();
    }
}
export async function readLiveBridgeMarker({ homeDir = tokenlessHome(), maxAgeMs = envNumber('TOKENLESS_BRIDGE_MAX_AGE_MS', DEFAULT_BRIDGE_MAX_AGE_MS), } = {}) {
    const candidates = [
        path.join(homeDir, EXTENSION_BRIDGE_FILE),
    ];
    for (const markerPath of candidates) {
        let parsed;
        try {
            parsed = JSON.parse(await fs.readFile(markerPath, 'utf8'));
        }
        catch {
            continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            continue;
        const payload = parsed;
        const marker = normalizeBridgeMarker(markerPath, payload, maxAgeMs);
        if (marker)
            return marker;
    }
    return null;
}
export async function waitForExtensionBridge({ homeDir = tokenlessHome(), timeoutMs = envNumber('TOKENLESS_BRIDGE_TIMEOUT_MS', 15_000), pollMs = 100, } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const marker = await readLiveBridgeMarker({ homeDir });
        if (marker)
            return marker;
        await delay(pollMs);
    }
    throw runtimeError('extension_bridge_timeout', `Tokenless opened the provider page, but the Rust extension bridge did not become ready within ${timeoutMs} ms. Check the extension and native-host installation with "tokenless doctor".`, true);
}
export function providerWakeUrl(provider, targetUrl) {
    const providerId = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
    if (!SUPPORTED_PROVIDERS.has(providerId)) {
        throw runtimeError('unsupported_provider', 'Provider must be one of: chatgpt, claude, gemini.', false);
    }
    const homeUrls = {
        chatgpt: 'https://chatgpt.com/',
        claude: 'https://claude.ai/new',
        gemini: 'https://gemini.google.com/app',
    };
    if (targetUrl === undefined || targetUrl === null || String(targetUrl).trim() === '') {
        return homeUrls[providerId];
    }
    let parsed;
    try {
        parsed = new URL(String(targetUrl));
    }
    catch {
        throw runtimeError('invalid_provider_url', 'Provider target URL must be a valid HTTPS URL.', false);
    }
    const allowedHosts = {
        chatgpt: new Set(['chatgpt.com', 'chat.openai.com']),
        claude: new Set(['claude.ai']),
        gemini: new Set(['gemini.google.com']),
    };
    if (parsed.protocol !== 'https:' ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        !allowedHosts[providerId]?.has(parsed.hostname.toLowerCase())) {
        throw runtimeError('invalid_provider_url', `Target URL must use HTTPS and belong to the selected ${providerId} provider.`, false);
    }
    return parsed.href;
}
export async function resolveChromiumBrowser(requested) {
    const requestedId = requested === undefined || requested === null || requested === ''
        ? null
        : normalizeBrowserId(requested);
    if (requested !== undefined && requested !== null && requested !== '' && !requestedId) {
        throw runtimeError('invalid_browser', 'Browser must be one of: chrome, chrome-for-testing, chromium, edge, arc, brave.', false);
    }
    if (requestedId === 'profile') {
        const executable = process.env.TOKENLESS_BROWSER_EXECUTABLE;
        if (!executable || !(await isExecutable(executable))) {
            throw runtimeError('browser_not_found', 'The profile browser is test-only and requires TOKENLESS_BROWSER_EXECUTABLE.', false);
        }
        return { browser: 'profile', command: executable, argsPrefix: [], displayName: 'test browser profile' };
    }
    const order = requestedId
        ? [requestedId]
        : ['chrome', 'brave', 'edge', 'arc', 'chromium'];
    for (const browser of order) {
        const launch = await browserLaunch(browser);
        if (launch)
            return launch;
    }
    throw runtimeError('chromium_browser_not_found', requestedId
        ? `Configured Chromium browser "${requestedId}" is not installed or executable.`
        : 'No supported Chromium browser was found. Install Chrome, Brave, Edge, Arc, or Chromium, then rerun tokenless install.', false);
}
export async function openProviderUrl(url, browser) {
    // Re-validate here so future callers cannot turn this into a general URL launcher.
    const parsed = new URL(url);
    const allowedHosts = new Set(['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com']);
    if (parsed.protocol !== 'https:' ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        !allowedHosts.has(parsed.hostname.toLowerCase())) {
        throw runtimeError('invalid_provider_url', 'Tokenless only opens allowlisted ChatGPT, Claude, or Gemini HTTPS pages.', false);
    }
    const child = spawn(browser.command, [...browser.argsPrefix, parsed.href], {
        detached: true,
        stdio: 'ignore',
    });
    await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
    });
    child.unref();
}
export async function installRustRuntime({ homeDir = tokenlessHome(), manifestHome, extensionId, browsers = ['chrome'], packageRoot, platform = process.platform, arch = process.arch, registerWindows = true, }) {
    if (!/^[a-p]{32}$/.test(extensionId)) {
        throw runtimeError('invalid_extension_id', 'Extension id must be the real 32-character Chrome extension id from chrome://extensions.', false);
    }
    const binDir = path.join(homeDir, 'bin');
    await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
    const daemonSource = bundledRustBinaryPath(DAEMON_BINARY_NAME, packageRoot, platform, arch);
    const hostSource = bundledRustBinaryPath(NATIVE_HOST_BINARY_NAME, packageRoot, platform, arch);
    const daemonExecutable = installedRustBinaryPath(homeDir, DAEMON_BINARY_NAME, platform);
    const nativeHostExecutable = installedRustBinaryPath(homeDir, NATIVE_HOST_BINARY_NAME, platform);
    await installExecutable(daemonSource, daemonExecutable);
    await installExecutable(hostSource, nativeHostExecutable);
    const manifest = {
        name: NATIVE_HOST_NAME,
        description: 'Tokenless Rust native messaging host',
        path: nativeHostExecutable,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extensionId}/`],
    };
    const manifests = [];
    const registryCommands = [];
    if (platform === 'win32') {
        const manifestPath = path.join(homeDir, 'native-messaging', `${NATIVE_HOST_NAME}.json`);
        await writeJsonAtomic(manifestPath, manifest, 0o600);
        manifests.push(manifestPath);
        for (const command of windowsNativeHostRegistryCommands({ manifestPath, browsers })) {
            registryCommands.push(command);
            if (registerWindows)
                await execFile(command[0], command.slice(1));
        }
    }
    else {
        for (const browser of browsers) {
            const browserId = normalizeBrowserId(browser);
            if (!browserId)
                continue;
            for (const dir of nativeMessagingHostDirs(browserId, manifestHome, platform)) {
                const manifestPath = path.join(dir, `${NATIVE_HOST_NAME}.json`);
                await writeJsonAtomic(manifestPath, manifest, 0o644);
                manifests.push(manifestPath);
            }
        }
    }
    return {
        runtime: 'rust',
        daemonExecutable,
        nativeHostExecutable,
        manifests,
        registryCommands,
        allowedOrigin: manifest.allowed_origins[0],
    };
}
export const installNativeHost = installRustRuntime;
export function windowsNativeHostRegistryCommands({ manifestPath, browsers, }) {
    const roots = {
        chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
        'chrome-for-testing': 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
        chromium: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
        edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
        brave: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
        arc: 'HKCU\\Software\\The Browser Company\\Arc\\NativeMessagingHosts',
    };
    const seen = new Set();
    const commands = [];
    for (const browser of browsers) {
        const browserId = normalizeBrowserId(browser);
        const root = browserId ? roots[browserId] : undefined;
        if (!root)
            continue;
        const key = `${root}\\${NATIVE_HOST_NAME}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        commands.push(['reg.exe', 'ADD', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']);
    }
    return commands;
}
export async function inspectNativeHostManifests({ homeDir = tokenlessHome(), manifestHome, browsers = ['chrome'], platform = process.platform, } = {}) {
    const candidates = platform === 'win32'
        ? [path.join(homeDir, 'native-messaging', `${NATIVE_HOST_NAME}.json`)]
        : browsers.flatMap((browser) => {
            const browserId = normalizeBrowserId(browser);
            return browserId
                ? nativeMessagingHostDirs(browserId, manifestHome, platform).map((dir) => path.join(dir, `${NATIVE_HOST_NAME}.json`))
                : [];
        });
    const uniqueCandidates = [...new Set(candidates)];
    const manifests = [];
    for (const manifestPath of uniqueCandidates) {
        try {
            const payload = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
            const expectedHost = installedRustBinaryPath(homeDir, NATIVE_HOST_BINARY_NAME, platform);
            const valid = payload.name === NATIVE_HOST_NAME &&
                payload.type === 'stdio' &&
                path.resolve(payload.path ?? '') === path.resolve(expectedHost) &&
                Array.isArray(payload.allowed_origins) &&
                payload.allowed_origins.length === 1 &&
                /^chrome-extension:\/\/[a-p]{32}\/$/.test(payload.allowed_origins[0]);
            manifests.push({ path: manifestPath, ok: valid, manifest: payload });
        }
        catch {
            // Missing manifests are summarized through candidate and valid counts below.
        }
    }
    return {
        ok: manifests.some((entry) => entry.ok),
        candidates: uniqueCandidates,
        manifests,
    };
}
export async function inspectRustBinaries(homeDir = tokenlessHome()) {
    const daemon = installedRustBinaryPath(homeDir, DAEMON_BINARY_NAME);
    const nativeHost = installedRustBinaryPath(homeDir, NATIVE_HOST_BINARY_NAME);
    const daemonOk = await isExecutable(daemon);
    const nativeHostOk = await isExecutable(nativeHost);
    let bundledDaemon = null;
    let bundledNativeHost = null;
    let packageError = null;
    try {
        bundledDaemon = bundledRustBinaryPath(DAEMON_BINARY_NAME);
        bundledNativeHost = bundledRustBinaryPath(NATIVE_HOST_BINARY_NAME);
    }
    catch (error) {
        packageError = error instanceof Error ? error.message : String(error);
    }
    const [daemonHash, nativeHostHash, bundledDaemonHash, bundledNativeHostHash] = await Promise.all([
        fileHash(daemon),
        fileHash(nativeHost),
        bundledDaemon ? fileHash(bundledDaemon) : null,
        bundledNativeHost ? fileHash(bundledNativeHost) : null,
    ]);
    const daemonMatchesBundled = Boolean(bundledDaemonHash) && daemonHash === bundledDaemonHash;
    const nativeHostMatchesBundled = Boolean(bundledNativeHostHash) && nativeHostHash === bundledNativeHostHash;
    return {
        ok: !packageError && daemonOk && nativeHostOk && daemonMatchesBundled && nativeHostMatchesBundled,
        package: { ok: !packageError, error: packageError },
        daemon: { ok: daemonOk, path: daemon, hash: daemonHash, bundledHash: bundledDaemonHash, matchesBundled: daemonMatchesBundled },
        nativeHost: { ok: nativeHostOk, path: nativeHost, hash: nativeHostHash, bundledHash: bundledNativeHostHash, matchesBundled: nativeHostMatchesBundled },
    };
}
export async function refreshInstalledRustBinaries({ homeDir = tokenlessHome(), packageRoot, } = {}) {
    const refreshed = [];
    for (const name of [DAEMON_BINARY_NAME, NATIVE_HOST_BINARY_NAME]) {
        const source = bundledRustBinaryPath(name, packageRoot);
        const destination = installedRustBinaryPath(homeDir, name);
        const [sourceHash, destinationHash] = await Promise.all([fileHash(source), fileHash(destination)]);
        if (!sourceHash) {
            throw runtimeError('rust_binary_missing', `Native runtime package is missing executable: ${source}`, false);
        }
        if (sourceHash === destinationHash)
            continue;
        await installExecutable(source, destination);
        refreshed.push(destination);
    }
    return refreshed;
}
export async function persistDaemonSnapshot({ homeDir = tokenlessHome(), jobId, provider, result, }) {
    const snapshot = unwrapSnapshot(result);
    if (!snapshot || snapshot.status !== 'snapshotted' || snapshot.sanitized !== true) {
        throw runtimeError('invalid_snapshot_payload', 'Daemon snapshot result is missing a sanitized snapshot payload.', false);
    }
    const snapshotProvider = safeSegment(snapshot.provider ?? provider);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(snapshotsDir(homeDir), snapshotProvider, `${stamp}-${safeSegment(jobId)}`);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const htmlPath = path.join(dir, 'dom.sanitized.html');
    const probesPath = path.join(dir, 'selector-probes.json');
    const metadataPath = path.join(dir, 'metadata.json');
    const textPath = typeof snapshot.visibleText === 'string'
        ? path.join(dir, 'visible-text.txt')
        : null;
    await fs.writeFile(htmlPath, `${typeof snapshot.html === 'string' ? snapshot.html : ''}\n`, { mode: 0o600 });
    await fs.writeFile(probesPath, `${JSON.stringify(snapshot.selectorProbes ?? {}, null, 2)}\n`, { mode: 0o600 });
    if (textPath)
        await fs.writeFile(textPath, `${snapshot.visibleText}\n`, { mode: 0o600 });
    const metadata = {
        protocol: 'tokenless.daemon-snapshot.v1',
        jobId,
        provider: snapshot.provider ?? provider,
        action: 'snapshot_dom',
        capturedAt: snapshot.capturedAt ?? new Date().toISOString(),
        url: snapshot.url,
        title: snapshot.title,
        sanitized: true,
        includeText: Boolean(snapshot.includeText),
        htmlPath,
        selectorProbesPath: probesPath,
        visibleTextPath: textPath,
    };
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    return { ...metadata, snapshotDir: dir, metadataPath };
}
async function spawnDaemon({ executable, homeDir, host, port, logPath, }) {
    const logFd = fsSync.openSync(logPath, 'a', 0o600);
    const child = spawn(executable, [
        '--home',
        homeDir,
        'serve',
        '--host',
        host,
        '--port',
        String(port),
    ], {
        detached: process.platform !== 'win32',
        env: { ...process.env, TOKENLESS_HOME: homeDir },
        stdio: ['ignore', logFd, logFd],
    });
    try {
        await new Promise((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
        });
    }
    catch (error) {
        throw runtimeError('daemon_start_failed', `Could not start Tokenless Rust daemon: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    finally {
        fsSync.closeSync(logFd);
    }
    if (!child.pid) {
        throw runtimeError('daemon_start_failed', 'Tokenless Rust daemon started without a process id.', true);
    }
    return child;
}
async function acquireDaemonStartLock({ homeDir, timeoutMs }) {
    const lockPath = path.join(homeDir, '.daemon-start.lock');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await fs.mkdir(lockPath, { mode: 0o700 });
            return async () => fs.rm(lockPath, { recursive: true, force: true });
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const stat = await fs.stat(lockPath).catch(() => null);
            if (stat && Date.now() - stat.mtimeMs > timeoutMs) {
                await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
                continue;
            }
            await delay(100);
        }
    }
    throw runtimeError('daemon_start_locked', `Timed out waiting for another Tokenless daemon startup in ${homeDir}.`, true);
}
function normalizeBridgeMarker(markerPath, payload, maxAgeMs) {
    const expectedKeys = ['connectedAt', 'heartbeatAt', 'pid', 'protocol', 'sessionId'];
    const actualKeys = Object.keys(payload).sort();
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
        return null;
    }
    if (payload.protocol !== EXTENSION_BRIDGE_PROTOCOL)
        return null;
    const pid = payload.pid;
    const sessionId = payload.sessionId;
    const connectedMs = strictIsoTimestampMs(payload.connectedAt);
    const heartbeatMs = strictIsoTimestampMs(payload.heartbeatAt);
    if (!Number.isInteger(pid) ||
        pid <= 0 ||
        pid > 2_147_483_647 ||
        typeof sessionId !== 'string' ||
        !sessionId.trim() ||
        connectedMs === null ||
        heartbeatMs === null) {
        return null;
    }
    const now = Date.now();
    if (connectedMs > now + BRIDGE_CLOCK_TOLERANCE_MS ||
        heartbeatMs > now + BRIDGE_CLOCK_TOLERANCE_MS ||
        connectedMs > heartbeatMs + BRIDGE_CLOCK_TOLERANCE_MS) {
        return null;
    }
    const heartbeatAgeMs = Math.max(0, now - heartbeatMs);
    if (heartbeatAgeMs > maxAgeMs || !pidIsAlive(pid))
        return null;
    return {
        path: markerPath,
        protocol: EXTENSION_BRIDGE_PROTOCOL,
        pid,
        sessionId,
        connectedAt: new Date(connectedMs).toISOString(),
        heartbeatAt: new Date(heartbeatMs).toISOString(),
        heartbeatAgeMs,
        raw: payload,
    };
}
function strictIsoTimestampMs(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
        return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}
function pidIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = error.code;
        if (code === 'EPERM')
            return true;
        if (code === 'ESRCH')
            return false;
        return false;
    }
}
function assertNoDaemonIdentityConflict(probe) {
    if (!probe.reachable)
        return;
    throw runtimeError(probe.code ?? 'daemon_not_ready', probe.message ?? `Daemon at ${probe.url} is reachable but cannot be used.`, false);
}
async function readDaemonPid(homeDir) {
    try {
        const payload = JSON.parse(await fs.readFile(path.join(homeDir, DAEMON_PID_FILE), 'utf8'));
        return Number.isInteger(payload.pid) && pidIsAlive(payload.pid) ? payload.pid : null;
    }
    catch {
        return null;
    }
}
async function removePidIfOwned(homeDir, pid) {
    const pidPath = path.join(homeDir, DAEMON_PID_FILE);
    try {
        const payload = JSON.parse(await fs.readFile(pidPath, 'utf8'));
        if (payload.pid === pid)
            await fs.rm(pidPath, { force: true });
    }
    catch {
        // Best-effort cleanup after a failed start.
    }
}
function readyHomeFromBody(body) {
    const value = body.home_dir;
    return typeof value === 'string' && value.trim() ? value : null;
}
function validateDaemonReadyProof(body, challenge, token) {
    if (body.ready_proof_protocol !== DAEMON_READY_PROOF_PROTOCOL ||
        body.ready_challenge !== challenge ||
        typeof body.daemon_protocol !== 'string' ||
        typeof body.native_protocol !== 'string' ||
        typeof body.home_dir !== 'string' ||
        typeof body.ready_proof !== 'string') {
        return {
            code: 'daemon_ready_proof_missing',
            message: 'Tokenless daemon /ready did not return a complete challenge-bound identity proof. Reinstall Tokenless.',
        };
    }
    let actualProof;
    try {
        actualProof = Buffer.from(body.ready_proof, 'base64url');
    }
    catch {
        actualProof = Buffer.alloc(0);
    }
    if (actualProof.length !== 32 || actualProof.toString('base64url') !== body.ready_proof) {
        return {
            code: 'daemon_ready_proof_invalid',
            message: 'Tokenless daemon /ready returned an invalid identity proof.',
        };
    }
    const expectedProof = createHmac('sha256', token)
        .update(daemonReadyProofMessage([
        DAEMON_READY_PROOF_PROTOCOL,
        challenge,
        body.daemon_protocol,
        body.native_protocol,
        body.home_dir,
    ]))
        .digest();
    if (!timingSafeEqual(actualProof, expectedProof)) {
        return {
            code: 'daemon_ready_proof_mismatch',
            message: 'Daemon identity proof does not match this Tokenless home; refusing to send its control token.',
        };
    }
    return null;
}
function daemonReadyProofMessage(fields) {
    const chunks = [];
    for (const field of fields) {
        const value = Buffer.from(field, 'utf8');
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(value.length);
        chunks.push(length, value);
    }
    return Buffer.concat(chunks);
}
function daemonBindHost(hostname) {
    if (hostname === 'localhost')
        return '127.0.0.1';
    if (hostname === '[::1]')
        return '::1';
    return hostname;
}
async function canonicalPath(value) {
    const resolved = path.resolve(value);
    return fs.realpath(resolved).catch(() => resolved);
}
async function installExecutable(source, destination) {
    if (!(await isExecutable(source))) {
        throw runtimeError('rust_binary_missing', `Packaged Rust binary is missing: ${source}`, false);
    }
    if (path.resolve(source) === path.resolve(destination))
        return;
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await fs.copyFile(source, temporary);
    if (process.platform !== 'win32')
        await fs.chmod(temporary, 0o755);
    await fs.rename(temporary, destination);
}
async function isExecutable(file) {
    try {
        await fs.access(file, process.platform === 'win32' ? fsSync.constants.F_OK : fsSync.constants.X_OK);
        return (await fs.stat(file)).isFile();
    }
    catch {
        return false;
    }
}
function executableName(name, platform = process.platform) {
    return `${name}${platform === 'win32' ? '.exe' : ''}`;
}
async function browserLaunch(browser) {
    const displayNames = {
        chrome: 'Google Chrome',
        'chrome-for-testing': 'Google Chrome for Testing',
        brave: 'Brave Browser',
        edge: 'Microsoft Edge',
        arc: 'Arc',
        chromium: 'Chromium',
    };
    if (process.platform === 'darwin') {
        const appNames = {
            chrome: 'Google Chrome.app',
            'chrome-for-testing': 'Google Chrome for Testing.app',
            brave: 'Brave Browser.app',
            edge: 'Microsoft Edge.app',
            arc: 'Arc.app',
            chromium: 'Chromium.app',
        };
        const appName = appNames[browser];
        if (!appName)
            return null;
        const appPaths = [path.join('/Applications', appName), path.join(os.homedir(), 'Applications', appName)];
        if (!(await firstExistingFile(appPaths)))
            return null;
        return {
            browser,
            command: '/usr/bin/open',
            argsPrefix: ['-a', displayNames[browser]],
            displayName: displayNames[browser],
        };
    }
    if (process.platform === 'win32') {
        const relativeExecutables = {
            chrome: ['Google/Chrome/Application/chrome.exe'],
            brave: ['BraveSoftware/Brave-Browser/Application/brave.exe'],
            edge: ['Microsoft/Edge/Application/msedge.exe'],
            arc: ['TheBrowserCompany/Arc/Application/Arc.exe'],
            chromium: ['Chromium/Application/chrome.exe'],
        };
        const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
            .filter((value) => Boolean(value));
        const candidates = roots.flatMap((root) => (relativeExecutables[browser] ?? []).map((relative) => path.join(root, relative)));
        const executable = await firstExistingFile(candidates);
        return executable
            ? { browser, command: executable, argsPrefix: [], displayName: displayNames[browser] }
            : null;
    }
    const executableNames = {
        chrome: ['google-chrome', 'google-chrome-stable'],
        'chrome-for-testing': ['google-chrome-for-testing'],
        brave: ['brave-browser', 'brave'],
        edge: ['microsoft-edge', 'microsoft-edge-stable'],
        arc: ['arc'],
        chromium: ['chromium', 'chromium-browser'],
    };
    const executable = await findOnPath(executableNames[browser] ?? []);
    return executable
        ? { browser, command: executable, argsPrefix: [], displayName: displayNames[browser] }
        : null;
}
async function firstExistingFile(candidates) {
    for (const candidate of candidates) {
        try {
            if ((await fs.stat(candidate)).isFile() || (await fs.stat(candidate)).isDirectory())
                return candidate;
        }
        catch {
            // Keep searching.
        }
    }
    return null;
}
async function findOnPath(names) {
    const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const name of names) {
        for (const directory of directories) {
            const candidate = path.join(directory, name);
            if (await isExecutable(candidate))
                return candidate;
        }
    }
    return null;
}
async function fileHash(file) {
    try {
        const contents = await fs.readFile(file);
        return createHash('sha256').update(contents).digest('hex');
    }
    catch {
        return null;
    }
}
function unwrapSnapshot(result) {
    if (!result || typeof result !== 'object')
        return null;
    const value = result;
    if (value.status === 'snapshotted')
        return value;
    if (value.snapshot?.status === 'snapshotted')
        return value.snapshot;
    if (value.result?.status === 'snapshotted')
        return value.result;
    if (value.result?.snapshot?.status === 'snapshotted')
        return value.result.snapshot;
    return null;
}
function safeSegment(value) {
    const normalized = String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized || 'provider';
}
async function writeJsonAtomic(file, payload, mode) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode });
    await fs.rename(temporary, file);
}
async function execFile(command, args) {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) {
        throw runtimeError('native_host_registry_failed', `${command} failed: ${stderr.trim()}`, false);
    }
}
function envNumber(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}
function runtimeError(code, message, retryable) {
    const error = new Error(message);
    error.code = code;
    error.retryable = retryable;
    return error;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=runtime.js.map