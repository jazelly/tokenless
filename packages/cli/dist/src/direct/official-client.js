import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DIRECT_PROTOCOL, DirectError } from './types.js';
const DEFAULT_TIMEOUT_MS = 120_000;
const PROCESS_OUTPUT_LIMIT_BYTES = 512 * 1024;
const DIAGNOSTIC_LIMIT_BYTES = 16 * 1024;
const LAST_MESSAGE_LIMIT_BYTES = 2 * 1024 * 1024;
const PROMPT_LIMIT_BYTES = 4 * 1024 * 1024;
const PROBE_REQUEST_LIMIT_BYTES = 1024 * 1024;
const RAW_EVENT_LIMIT = 128;
const TERMINATION_GRACE_MS = 500;
const PERMISSION_PROFILE_NAME = 'tokenless_direct';
const SANDBOX_CANARY_OUTPUT = 'TOKENLESS_SANDBOX_CANARY_EXECUTED';
const MAIN_PERMISSION_PROFILE = 'permissions={tokenless_direct={workspace_roots={"."=true},filesystem={":root"="deny",":workspace_roots"="read"},network={enabled=false}}}';
const REQUIRED_DISABLED_FEATURES = [
    'apps',
    'auth_elicitation',
    'browser_use',
    'browser_use_external',
    'browser_use_full_cdp_access',
    'code_mode',
    'code_mode_host',
    'code_mode_only',
    'computer_use',
    'deferred_executor',
    'enable_fanout',
    'enable_mcp_apps',
    'exec_permission_approvals',
    'guardian_approval',
    'hooks',
    'image_generation',
    'imagegenext',
    'in_app_browser',
    'js_repl',
    'js_repl_tools_only',
    'memories',
    'multi_agent',
    'multi_agent_v2',
    'plugin_sharing',
    'plugins',
    'remote_plugin',
    'request_permissions_tool',
    'respect_system_proxy',
    'search_tool',
    'shell_snapshot',
    'shell_tool',
    'skill_mcp_dependency_install',
    'standalone_web_search',
    'tool_call_mcp_elicitation',
    'tool_suggest',
    'unified_exec',
    'workspace_dependencies',
];
const REQUIRED_EXEC_HELP_TOKENS = [
    '--config',
    '--disable',
    '--strict-config',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--json',
    '--output-last-message',
    '--model',
];
const REQUIRED_SANDBOX_HELP_TOKENS = ['--config', '--permission-profile', '--cd'];
// Codex needs its own home directory to find provider-owned authentication,
// plus a small set of process-launch and platform variables. Everything else
// is dropped so credentials, routing overrides, loader injection, proxies, and
// application-specific state cannot cross this boundary accidentally.
const ALLOWED_CHILD_ENVIRONMENT = [
    'APPDATA',
    'CODEX_HOME',
    'COMSPEC',
    'HOMEDRIVE',
    'HOMEPATH',
    'HOME',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'LC_CTYPE',
    'LOCALAPPDATA',
    'LOGNAME',
    'OS',
    'PATH',
    'PATHEXT',
    'PROGRAMDATA',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'TZ',
    'USER',
    'USERNAME',
    'USERPROFILE',
    'WINDIR',
];
export class DirectOfficialClientError extends DirectError {
    reason;
    stage;
    exitCode;
    constructor({ code, reason, message, retryable = false, stage, exitCode, }) {
        super(code, message, { retryable });
        this.reason = reason;
        if (stage !== undefined)
            this.stage = stage;
        if (exitCode !== undefined)
            this.exitCode = exitCode;
    }
    toJSON() {
        return {
            ...super.toJSON(),
            reason: this.reason,
            ...(this.stage === undefined ? {} : { stage: this.stage }),
            ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
        };
    }
}
/**
 * Run the provider-owned Codex client for a ChatGPT-plan request.
 *
 * Tokenless never reads Codex's credential store. Codex receives the prompt only
 * on stdin and runs from a newly-created, empty working directory.
 */
export async function runOfficialCodex(request, options = {}) {
    const validated = validateRequest(request);
    if (process.platform === 'win32') {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'codex_unsupported',
            message: 'The official Codex backend currently supports macOS and Linux. Use backend api on Windows.',
        });
    }
    const executable = resolveExecutable(options.executable);
    const timeoutMs = resolveTimeout(options.timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const childEnvironment = officialCodexEnvironment(process.env);
    let temporaryRoot;
    let operationFailed = false;
    try {
        throwIfAborted(request.signal);
        temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-codex-'));
        const preflightDirectory = path.join(temporaryRoot, 'preflight');
        const workingDirectory = path.join(temporaryRoot, 'workspace');
        const isolatedCodexHome = path.join(temporaryRoot, 'probe-home');
        const outputPath = path.join(temporaryRoot, 'last-message.txt');
        await Promise.all([
            fs.mkdir(preflightDirectory, { mode: 0o700 }),
            fs.mkdir(workingDirectory, { mode: 0o700 }),
            fs.mkdir(isolatedCodexHome, { mode: 0o700 }),
        ]);
        throwIfAborted(request.signal);
        await validateCodexCapabilities({
            executable,
            cwd: preflightDirectory,
            workspace: workingDirectory,
            isolatedCodexHome,
            deadline,
            signal: request.signal,
            env: childEnvironment,
        });
        await validateChatGptAuthentication({
            executable,
            cwd: preflightDirectory,
            deadline,
            signal: request.signal,
            env: childEnvironment,
        });
        throwIfAborted(request.signal);
        const args = [
            'exec',
            '--strict-config',
            ...codexConfigurationArgs(MAIN_PERMISSION_PROFILE),
            ...disabledFeatureArgs(),
            '--ephemeral',
            '--ignore-user-config',
            '--ignore-rules',
            '--skip-git-repo-check',
            '--color',
            'never',
            '--json',
            '--output-last-message',
            outputPath,
            ...(validated.model === undefined ? [] : ['--model', validated.model]),
        ];
        const child = await runChild({
            executable,
            args,
            cwd: workingDirectory,
            env: childEnvironment,
            stdin: request.prompt,
            timeoutMs: remainingTime(deadline),
            signal: request.signal,
        });
        throwForTermination(child, 'execution');
        if (child.code !== 0) {
            throw new DirectOfficialClientError({
                code: 'direct_upstream_error',
                reason: 'codex_nonzero_exit',
                message: 'The official Codex client exited unsuccessfully.',
                retryable: true,
                stage: 'execution',
                exitCode: child.code,
            });
        }
        const machineOutput = parseMachineEvents(child.stdout);
        const text = await readLastMessage(outputPath);
        return {
            protocol: DIRECT_PROTOCOL,
            backend: 'official-client',
            transport: 'official-codex',
            capability: 'openai.codex',
            provider: 'chatgpt',
            ...(validated.model === undefined ? {} : { model: validated.model }),
            text,
            ...(machineOutput.usage === undefined ? {} : { usage: machineOutput.usage }),
            raw: machineOutput.raw,
        };
    }
    catch (error) {
        operationFailed = true;
        throw normalizeOfficialClientFailure(error);
    }
    finally {
        if (temporaryRoot !== undefined) {
            try {
                await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
            }
            catch {
                if (!operationFailed) {
                    throw new DirectOfficialClientError({
                        code: 'direct_upstream_error',
                        reason: 'codex_cleanup_failed',
                        message: 'The official Codex client could not remove its isolated temporary files.',
                    });
                }
            }
        }
    }
}
function normalizeOfficialClientFailure(error) {
    if (error instanceof DirectOfficialClientError)
        return error;
    if (isMissingExecutableError(error)) {
        return new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'codex_binary_missing',
            message: 'The Codex executable was not found. Install Codex or set TOKENLESS_CODEX_BIN.',
        });
    }
    if (isNotExecutableError(error)) {
        return new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'codex_binary_not_executable',
            message: 'The configured Codex executable cannot be executed.',
        });
    }
    return new DirectOfficialClientError({
        code: 'direct_upstream_error',
        reason: 'codex_operational_failure',
        message: 'The official Codex client could not complete its isolated operation.',
    });
}
function validateRequest(request) {
    if (request === null || typeof request !== 'object') {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'invalid_request',
            message: 'A direct run request is required for the official Codex client.',
        });
    }
    if (request.provider !== 'chatgpt') {
        throw new DirectOfficialClientError({
            code: 'direct_unsupported_provider',
            reason: 'unsupported_official_client_provider',
            message: 'The official Codex client backend supports only the chatgpt provider.',
        });
    }
    if (request.backend !== undefined && request.backend !== 'official-client') {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'invalid_request',
            message: 'The official Codex runner requires backend official-client.',
        });
    }
    if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'invalid_request',
            message: 'A nonempty prompt is required for the official Codex client.',
        });
    }
    if (Buffer.byteLength(request.prompt, 'utf8') > PROMPT_LIMIT_BYTES) {
        throw new DirectOfficialClientError({
            code: 'direct_request_too_large',
            reason: 'codex_prompt_too_large',
            message: 'The official Codex client prompt exceeded the supported size limit.',
        });
    }
    if (request.model !== undefined &&
        (typeof request.model !== 'string' || request.model.trim() === '' || request.model.includes('\0'))) {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'invalid_request',
            message: 'The Codex model must be nonempty when provided.',
        });
    }
    if (request.maxOutputTokens !== undefined || request.temperature !== undefined) {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'invalid_request',
            message: 'The official Codex client does not accept maxOutputTokens or temperature.',
        });
    }
    return { model: request.model?.trim() };
}
function resolveExecutable(option) {
    const executable = option ?? process.env.TOKENLESS_CODEX_BIN ?? 'codex';
    if (executable.trim() === '' || executable.includes('\0')) {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'invalid_request',
            message: 'The configured Codex executable must be a nonempty path or command name.',
        });
    }
    return executable;
}
function resolveTimeout(option) {
    const environmentValue = process.env.TOKENLESS_DIRECT_TIMEOUT_MS;
    const timeout = option ?? (environmentValue === undefined ? DEFAULT_TIMEOUT_MS : Number(environmentValue));
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'invalid_request',
            message: 'The direct Codex timeout must be a positive integer in milliseconds.',
        });
    }
    return timeout;
}
function officialCodexEnvironment(environment) {
    const result = {};
    const available = new Map();
    for (const [key, value] of Object.entries(environment)) {
        if (value !== undefined && !available.has(key.toUpperCase()))
            available.set(key.toUpperCase(), value);
    }
    for (const name of ALLOWED_CHILD_ENVIRONMENT) {
        const value = available.get(name);
        if (value !== undefined)
            result[name] = value;
    }
    // This is a provider-owned fail-closed switch, not an inherited routing
    // override. Codex omits its local/remote execution environment when it is
    // exactly `none`, which removes model-facing shell and filesystem tools.
    result.CODEX_EXEC_SERVER_URL = 'none';
    return result;
}
function codexConfigurationArgs(permissionProfile) {
    return [
        '--config',
        `default_permissions="${PERMISSION_PROFILE_NAME}"`,
        '--config',
        permissionProfile,
        '--config',
        'approval_policy="never"',
        '--config',
        'shell_environment_policy.inherit="none"',
        '--config',
        'project_doc_max_bytes=0',
        '--config',
        'web_search="disabled"',
        '--config',
        'skills.include_instructions=false',
        '--config',
        'skills.bundled.enabled=false',
        '--config',
        'orchestrator.skills.enabled=false',
        '--config',
        'orchestrator.mcp.enabled=false',
        '--config',
        'tools.experimental_request_user_input.enabled=false',
    ];
}
function disabledFeatureArgs() {
    return REQUIRED_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]);
}
async function validateCodexCapabilities({ executable, cwd, workspace, isolatedCodexHome, deadline, signal, env, }) {
    const preflightEnvironment = { ...env, CODEX_HOME: isolatedCodexHome };
    const execHelp = await runChild({
        executable,
        args: ['exec', '--help'],
        cwd,
        env: preflightEnvironment,
        timeoutMs: remainingTime(deadline),
        signal,
    });
    throwForTermination(execHelp, 'capability');
    if (execHelp.code !== 0) {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'codex_unsupported',
            message: 'The installed Codex client could not report its exec capabilities.',
            stage: 'capability',
            exitCode: execHelp.code,
        });
    }
    const help = Buffer.concat([execHelp.stdout.bytes, execHelp.stderr.bytes]).toString('utf8');
    const missing = REQUIRED_EXEC_HELP_TOKENS.filter((token) => !hasHelpToken(help, token));
    if (execHelp.stdout.truncated || execHelp.stderr.truncated || missing.length > 0) {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'codex_unsupported',
            message: missing.length === 0
                ? 'The installed Codex client returned an oversized capability description. Upgrade Codex.'
                : `The installed Codex client lacks required isolation capabilities (${missing.join(', ')}). Upgrade Codex.`,
            stage: 'capability',
        });
    }
    const features = await runChild({
        executable,
        args: ['features', 'list'],
        cwd,
        env: preflightEnvironment,
        timeoutMs: remainingTime(deadline),
        signal,
    });
    throwForTermination(features, 'capability');
    const availableFeatures = parseFeatureNames(features.stdout.bytes);
    const missingFeatures = REQUIRED_DISABLED_FEATURES.filter((feature) => !availableFeatures.has(feature));
    if (features.code !== 0 ||
        features.stdout.truncated ||
        features.stderr.truncated ||
        missingFeatures.length > 0) {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'codex_unsupported',
            message: missingFeatures.length === 0
                ? 'The installed Codex client could not report a bounded feature catalog.'
                : `The installed Codex client lacks required feature controls (${missingFeatures.join(', ')}). Upgrade Codex.`,
            stage: 'capability',
            exitCode: features.code,
        });
    }
    const sandboxHelp = await runChild({
        executable,
        args: ['sandbox', '--help'],
        cwd,
        env: preflightEnvironment,
        timeoutMs: remainingTime(deadline),
        signal,
    });
    throwForTermination(sandboxHelp, 'capability');
    const sandboxHelpText = Buffer.concat([sandboxHelp.stdout.bytes, sandboxHelp.stderr.bytes]).toString('utf8');
    const missingSandboxCapabilities = REQUIRED_SANDBOX_HELP_TOKENS.filter((token) => !hasHelpToken(sandboxHelpText, token));
    if (sandboxHelp.code !== 0 ||
        sandboxHelp.stdout.truncated ||
        sandboxHelp.stderr.truncated ||
        missingSandboxCapabilities.length > 0) {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'codex_unsupported',
            message: missingSandboxCapabilities.length === 0
                ? 'The installed Codex client could not report bounded sandbox capabilities.'
                : `The installed Codex client lacks required sandbox capabilities (${missingSandboxCapabilities.join(', ')}). Upgrade Codex.`,
            stage: 'capability',
            exitCode: sandboxHelp.code,
        });
    }
    await validateSandboxDeniesLocalExecution({
        executable,
        workspace,
        deadline,
        signal,
        env: preflightEnvironment,
    });
    await validateCodexToolSchema({
        executable,
        workspace,
        deadline,
        signal,
        env: preflightEnvironment,
    });
}
function parseFeatureNames(output) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(output);
    }
    catch {
        return new Set();
    }
    const features = new Set();
    for (const line of text.split(/\r?\n/)) {
        const match = /^([a-z][a-z0-9_]*)\s+.+\s+(?:true|false)\s*$/.exec(line.trim());
        if (match?.[1] !== undefined)
            features.add(match[1]);
    }
    return features;
}
async function validateSandboxDeniesLocalExecution({ executable, workspace, deadline, signal, env, }) {
    const canary = await runChild({
        executable,
        args: [
            'sandbox',
            ...codexConfigurationArgs(MAIN_PERMISSION_PROFILE),
            '--permission-profile',
            PERMISSION_PROFILE_NAME,
            '--cd',
            workspace,
            '--',
            process.execPath,
            '-e',
            `process.stdout.write(${JSON.stringify(SANDBOX_CANARY_OUTPUT)})`,
        ],
        cwd: workspace,
        env,
        timeoutMs: remainingTime(deadline),
        signal,
    });
    throwForTermination(canary, 'capability');
    const stdout = canary.stdout.bytes.toString('utf8').trim();
    const stderr = canary.stderr.bytes.toString('utf8').trim();
    const explicitDenial = /(?:permission denied|operation not permitted|access is denied|sandbox denial)/i.test(stderr);
    // On macOS, a denied dynamic-loader/bootstrap read terminates Node with
    // SIGABRT (128 + 6) before it can emit a diagnostic. That exact empty-output
    // result is the platform's reproducible fail-closed signature.
    const macOsBootstrapDenial = process.platform === 'darwin' && canary.code === 134 && stdout === '' && stderr === '';
    if (canary.code === 0 ||
        canary.code === null ||
        canary.stdout.truncated ||
        canary.stderr.truncated ||
        stdout.includes(SANDBOX_CANARY_OUTPUT) ||
        (!explicitDenial && !macOsBootstrapDenial)) {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'codex_unsupported',
            message: 'The installed Codex client did not prove that the Tokenless sandbox denies local execution.',
            stage: 'capability',
            exitCode: canary.code,
        });
    }
}
async function validateCodexToolSchema({ executable, workspace, deadline, signal, env, }) {
    let observed;
    let requestCount = 0;
    let requestFailure;
    const server = http.createServer((request, response) => {
        void (async () => {
            requestCount += 1;
            try {
                const body = await readProbeRequest(request);
                observed = {
                    method: request.method,
                    url: request.url,
                    authorization: request.headers.authorization,
                    cookie: request.headers.cookie,
                    body,
                };
                response.writeHead(200, {
                    'cache-control': 'no-cache',
                    'content-type': 'text/event-stream',
                });
                response.end('event: response.created\n' +
                    'data: {"type":"response.created","response":{"id":"tokenless-probe"}}\n\n' +
                    'event: response.completed\n' +
                    'data: {"type":"response.completed","response":{"id":"tokenless-probe","usage":{"input_tokens":0,"input_tokens_details":null,"output_tokens":0,"output_tokens_details":null,"total_tokens":0}}}\n\n');
            }
            catch (error) {
                requestFailure = error instanceof Error ? error.message : 'invalid probe request';
                if (!response.headersSent)
                    response.writeHead(400, { 'content-type': 'text/plain' });
                response.end('invalid probe request');
            }
        })();
    });
    await listenOnLoopback(server);
    const address = server.address();
    if (address === null || typeof address === 'string') {
        await closeServer(server);
        throw unsupportedCapability('The Codex tool-isolation probe could not bind a loopback server.');
    }
    const probeEnvironment = {
        ...env,
        TOKENLESS_PROBE_API_KEY: 'tokenless-probe-only',
    };
    const providerConfig = `model_providers.tokenless_probe={name="Tokenless Probe",base_url="http://127.0.0.1:${address.port}/v1",` +
        'env_key="TOKENLESS_PROBE_API_KEY",wire_api="responses",supports_websockets=false,request_max_retries=0,stream_max_retries=0}';
    let child;
    try {
        child = await runChild({
            executable,
            args: [
                'exec',
                '--strict-config',
                ...codexConfigurationArgs(MAIN_PERMISSION_PROFILE),
                ...disabledFeatureArgs(),
                '--config',
                'model_provider="tokenless_probe"',
                '--config',
                providerConfig,
                '--ephemeral',
                '--ignore-user-config',
                '--ignore-rules',
                '--skip-git-repo-check',
                '--color',
                'never',
                '--json',
                '--model',
                'gpt-5.1',
            ],
            cwd: workspace,
            env: probeEnvironment,
            stdin: 'Return exactly OK without calling any tools.',
            timeoutMs: remainingTime(deadline),
            signal,
        });
    }
    finally {
        await closeServer(server);
    }
    throwForTermination(child, 'capability');
    const body = observed?.body;
    const tools = isRecord(body) && Array.isArray(body.tools) ? body.tools : undefined;
    const serializedBody = body === undefined ? '' : JSON.stringify(body);
    const exactSafeToolSet = tools?.length === 1 && isRecord(tools[0]) && tools[0].type === 'function' && tools[0].name === 'update_plan';
    const exposesSkillContext = /<skills_instructions>|SKILL\.md|(?:[/\\])\.agents(?:[/\\])skills/i.test(serializedBody);
    if (child.code !== 0 ||
        child.stdout.truncated ||
        child.stderr.truncated ||
        requestCount !== 1 ||
        requestFailure !== undefined ||
        observed?.method !== 'POST' ||
        observed.url !== '/v1/responses' ||
        observed.authorization !== 'Bearer tokenless-probe-only' ||
        observed.cookie !== undefined ||
        exposesSkillContext ||
        !exactSafeToolSet) {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'codex_unsupported',
            message: 'The installed Codex client did not prove the required model-facing tool isolation.',
            stage: 'capability',
            exitCode: child.code,
        });
    }
}
async function readProbeRequest(request) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > PROBE_REQUEST_LIMIT_BYTES)
            throw new Error('oversized probe request');
        chunks.push(bytes);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
    return JSON.parse(text);
}
async function listenOnLoopback(server) {
    await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', onError);
            resolve();
        });
    });
}
async function closeServer(server) {
    if (!server.listening)
        return;
    const closed = new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    server.closeAllConnections();
    await closed;
}
function unsupportedCapability(message) {
    return new DirectOfficialClientError({
        code: 'direct_configuration_error',
        reason: 'codex_unsupported',
        message,
        stage: 'capability',
    });
}
async function validateChatGptAuthentication({ executable, cwd, deadline, signal, env, }) {
    const child = await runChild({
        executable,
        args: ['login', 'status'],
        cwd,
        env,
        timeoutMs: remainingTime(deadline),
        signal,
    });
    throwForTermination(child, 'authentication');
    const statusFragments = [child.stdout.bytes, child.stderr.bytes]
        .map((bytes) => bytes.toString('utf8').trim())
        .filter((value) => value !== '');
    if (child.code !== 0 ||
        child.stdout.truncated ||
        child.stderr.truncated ||
        statusFragments.length !== 1 ||
        !/^logged in using chatgpt$/i.test(statusFragments[0] ?? '')) {
        throw new DirectOfficialClientError({
            code: 'direct_configuration_error',
            reason: 'codex_not_chatgpt_authenticated',
            message: 'Codex is not authenticated with ChatGPT. Run codex login and choose ChatGPT.',
            stage: 'authentication',
            exitCode: child.code,
        });
    }
}
function remainingTime(deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
        throw new DirectOfficialClientError({
            code: 'direct_timeout',
            reason: 'codex_timeout',
            message: 'The official Codex client timed out.',
            retryable: true,
        });
    }
    return remaining;
}
function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw new DirectOfficialClientError({
            code: 'direct_upstream_error',
            reason: 'codex_aborted',
            message: 'The official Codex client request was aborted.',
            retryable: true,
        });
    }
}
function throwForTermination(result, stage) {
    if (result.termination === 'timeout') {
        throw new DirectOfficialClientError({
            code: 'direct_timeout',
            reason: 'codex_timeout',
            message: 'The official Codex client timed out.',
            retryable: true,
            stage,
        });
    }
    if (result.termination === 'aborted') {
        throw new DirectOfficialClientError({
            code: 'direct_upstream_error',
            reason: 'codex_aborted',
            message: 'The official Codex client request was aborted.',
            retryable: true,
            stage,
        });
    }
}
async function readLastMessage(outputPath) {
    let handle;
    try {
        handle = await fs.open(outputPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    }
    catch (error) {
        if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ELOOP')) {
            throw invalidOutputError('The official Codex client did not produce a safe last-message file.');
        }
        throw error;
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > LAST_MESSAGE_LIMIT_BYTES) {
            throw invalidOutputError('The official Codex client produced a missing, empty, or oversized last message.');
        }
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < stat.size) {
            const { bytesRead } = await handle.read(bytes, offset, stat.size - offset, offset);
            if (bytesRead === 0) {
                throw invalidOutputError('The official Codex client produced an incomplete last message.');
            }
            offset += bytesRead;
        }
        let decoded;
        try {
            decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        catch {
            throw invalidOutputError('The official Codex client produced a non-UTF-8 last message.');
        }
        const text = decoded.replace(/^\uFEFF/, '').trim();
        if (text === '') {
            throw invalidOutputError('The official Codex client produced an empty last message.');
        }
        return text;
    }
    finally {
        await handle.close();
    }
}
function parseMachineEvents(output) {
    let bytes = output.bytes;
    if (output.truncated) {
        const lastNewline = bytes.lastIndexOf(0x0a);
        bytes = lastNewline === -1 ? Buffer.alloc(0) : bytes.subarray(0, lastNewline + 1);
    }
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        throw invalidOutputError('The official Codex client produced non-UTF-8 machine output.');
    }
    const lines = text.split(/\r?\n/);
    const events = [];
    let truncated = output.truncated;
    let usage;
    for (const line of lines) {
        if (line.trim() === '')
            continue;
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            throw invalidOutputError('The official Codex client produced invalid JSONL machine output.');
        }
        if (event === null || typeof event !== 'object' || Array.isArray(event)) {
            throw invalidOutputError('The official Codex client produced an invalid machine event.');
        }
        const eventUsage = normalizeCodexUsage(event);
        if (eventUsage !== undefined)
            usage = eventUsage;
        if (events.length < RAW_EVENT_LIMIT)
            events.push(event);
        else
            truncated = true;
    }
    if (events.length === 0) {
        throw invalidOutputError('The official Codex client produced no machine events.');
    }
    return {
        raw: { events, truncated },
        ...(usage === undefined ? {} : { usage }),
    };
}
function normalizeCodexUsage(event) {
    if (event.type !== 'turn.completed' || !isRecord(event.usage))
        return undefined;
    const inputTokens = nonnegativeInteger(event.usage.input_tokens);
    const outputTokens = nonnegativeInteger(event.usage.output_tokens);
    const reportedTotal = nonnegativeInteger(event.usage.total_tokens);
    const totalTokens = reportedTotal ?? (inputTokens === undefined || outputTokens === undefined ? undefined : inputTokens + outputTokens);
    if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined)
        return undefined;
    return {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(totalTokens === undefined ? {} : { totalTokens }),
    };
}
function nonnegativeInteger(value) {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalidOutputError(message) {
    return new DirectOfficialClientError({
        code: 'direct_invalid_response',
        reason: 'codex_invalid_output',
        message,
        stage: 'execution',
    });
}
async function runChild({ executable, args, cwd, env, stdin, timeoutMs, signal, }) {
    throwIfAborted(signal);
    return await new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(executable, args, {
                cwd,
                env,
                detached: process.platform !== 'win32',
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
        }
        catch (error) {
            reject(error);
            return;
        }
        const stdout = createBoundedCollector(PROCESS_OUTPUT_LIMIT_BYTES);
        const stderr = createBoundedCollector(DIAGNOSTIC_LIMIT_BYTES);
        child.stdout.on('data', stdout.append);
        child.stderr.on('data', stderr.append);
        let settled = false;
        let termination;
        let forceTimer;
        let forceKillCompleted = false;
        let finishAfterForceKill;
        const terminate = (reason) => {
            if (child.exitCode !== null || child.signalCode !== null)
                return;
            if (termination !== undefined)
                return;
            termination = reason;
            terminateChildTree(child, 'SIGTERM');
            forceTimer = setTimeout(() => {
                // Address the process group even if the direct child has already
                // exited. A descendant may ignore SIGTERM and outlive its parent.
                terminateChildTree(child, 'SIGKILL');
                forceKillCompleted = true;
                finishAfterForceKill?.();
            }, TERMINATION_GRACE_MS);
        };
        const timeout = setTimeout(() => terminate('timeout'), timeoutMs);
        const onAbort = () => terminate('aborted');
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            if (forceTimer !== undefined && termination === undefined)
                clearTimeout(forceTimer);
            signal?.removeEventListener('abort', onAbort);
            callback();
        };
        child.once('error', (error) => finish(() => reject(error)));
        child.once('close', (code, childSignal) => {
            const resolveResult = () => finish(() => resolve({
                code,
                signal: childSignal,
                stdout: stdout.result(),
                stderr: stderr.result(),
                termination,
            }));
            if (termination !== undefined && process.platform !== 'win32' && !forceKillCompleted) {
                finishAfterForceKill = resolveResult;
                return;
            }
            resolveResult();
        });
        child.stdin.on('error', () => {
            // A failing process may close stdin before Node finishes writing. Its exit
            // status and bounded stderr remain the authoritative failure signal.
        });
        child.stdin.end(stdin);
    });
}
function terminateChildTree(child, signal) {
    if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
            process.kill(-child.pid, signal);
            return;
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'ESRCH') {
                // Fall through to the direct child. A process-group kill is best effort,
                // while the direct child must still be terminated.
            }
        }
    }
    child.kill(signal);
}
function createBoundedCollector(limit) {
    const chunks = [];
    let length = 0;
    let truncated = false;
    return {
        append(chunk) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remaining = limit - length;
            if (remaining > 0) {
                const accepted = bytes.subarray(0, remaining);
                chunks.push(accepted);
                length += accepted.length;
            }
            if (bytes.length > remaining)
                truncated = true;
        },
        result() {
            return { bytes: Buffer.concat(chunks, length), truncated };
        },
    };
}
function hasHelpToken(help, token) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[\\s,\\[])${escaped}(?=$|[\\s,=<>\\][])`, 'm').test(help);
}
function isMissingExecutableError(error) {
    return isNodeError(error) && error.code === 'ENOENT';
}
function isNotExecutableError(error) {
    return isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ENOEXEC');
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
//# sourceMappingURL=official-client.js.map