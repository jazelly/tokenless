#!/usr/bin/env node
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { buildTokenlessPrompt, buildTaskUrl, createDaemonJob, createLocalJob, deriveTaskId, installNativeHost, normalizeBrowserId, readLocalTaskState, readTokenlessConfig, tokenlessHome, waitDaemonJobResult, waitLocalJobResult, writeTokenlessConfig, } from './index.js';
import { DEFAULT_EXTENSION_ID } from './default-extension-id.js';
const argv = process.argv.slice(2);
const command = argv[0]?.startsWith('-') ? 'prompt' : (argv.shift() ?? 'help');
const args = parseArgs(argv);
try {
    if (command === 'run') {
        await runCommand(args);
    }
    else if (command === 'state' || command === 'status') {
        await stateCommand(args);
    }
    else if (command === 'snapshot-dom') {
        await snapshotDomCommand(args);
    }
    else if (command === 'install') {
        await installCommand(args);
    }
    else if (command === 'doctor') {
        await doctorCommand(args);
    }
    else if (command === 'config') {
        await configCommand(args);
    }
    else if (command === 'prompt') {
        await promptCommand(args);
    }
    else {
        usage();
        process.exit(command === 'help' ? 0 : 2);
    }
}
catch (error) {
    const cliError = error;
    const payload = {
        ok: false,
        error: {
            code: cliError.code || 'tokenless_cli_error',
            message: cliError.message || 'Tokenless CLI failed.',
            retryable: Boolean(cliError.retryable),
        },
    };
    if (cliError.status) {
        payload.status = cliError.status;
    }
    if (Array.isArray(cliError.statusLog)) {
        payload.statusLog = cliError.statusLog;
    }
    if (args.json) {
        console.log(JSON.stringify(payload, null, 2));
    }
    else {
        console.error(`${payload.error.code}: ${payload.error.message}`);
    }
    process.exit(1);
}
async function snapshotDomCommand(args) {
    const { extensionId } = resolveExtensionId(args);
    const homeDir = tokenlessHome(args.home);
    const config = await readTokenlessConfig(homeDir);
    const { browser } = resolveBrowser(args, config);
    const provider = args.provider ||
        process.env.TOKENLESS_PROVIDER ||
        config.preferredProviders[0] ||
        'chatgpt';
    const job = await createLocalJob({
        homeDir,
        provider,
        action: 'snapshot_dom',
        projectRoot: args.projectRoot,
        projectName: args.projectName || process.env.TOKENLESS_PROJECT_NAME,
        chatName: args.chatName || process.env.TOKENLESS_CHAT_NAME || 'DOM snapshot',
        targetUrl: args.targetUrl,
        idempotencyKey: args.taskId || args.idempotencyKey || process.env.TOKENLESS_TASK_ID || process.env.TOKENLESS_IDEMPOTENCY_KEY,
        includeText: Boolean(args.includeText),
        maxTextChars: args.maxTextChars === undefined ? undefined : Number(args.maxTextChars),
        metadata: {
            source: 'tokenless-cli',
            browser,
            includeText: Boolean(args.includeText),
            maxTextChars: args.maxTextChars === undefined ? undefined : Number(args.maxTextChars),
        },
    });
    const statusReporter = createCliStatusReporter(args);
    statusReporter.report({
        event: 'created',
        status: job.status,
        jobId: job.jobId,
        taskId: job.taskId,
        provider: job.provider,
        action: job.action,
        route: job.conversation?.route,
    });
    const taskUrl = buildTaskUrl({ extensionId, jobId: job.jobId, nonce: job.nonce });
    if (!args.noOpen) {
        await openUrl(taskUrl, { browser: browser ?? undefined });
        statusReporter.report({
            event: 'opened',
            status: 'opened_task_page',
            jobId: job.jobId,
            taskId: job.taskId,
            provider: job.provider,
            browser,
            taskUrl,
        });
    }
    else {
        statusReporter.report({
            event: 'not_opened',
            status: 'waiting_for_external_open',
            jobId: job.jobId,
            taskId: job.taskId,
            provider: job.provider,
            taskUrl,
        });
    }
    const result = args.noWait
        ? (statusReporter.report({
            event: 'detached',
            status: 'no_wait',
            jobId: job.jobId,
            taskId: job.taskId,
            provider: job.provider,
        }), null)
        : await waitLocalJobResultWithStatus({
            homeDir,
            jobId: job.jobId,
            nonce: job.nonce,
            timeoutMs: args.timeoutMs === undefined ? 60000 : Number(args.timeoutMs),
            statusReporter,
            taskId: job.taskId,
        });
    assertLocalJobSucceeded(result, statusReporter);
    printPayload({
        ok: true,
        jobId: job.jobId,
        taskId: job.taskId,
        provider: job.provider,
        taskUrl,
        result,
        snapshot: result?.result?.snapshot,
        compactOutput: result?.compactOutput,
        status: result?.status ?? statusReporter.lastStatus(),
        statusLog: statusReporter.events,
    }, args);
}
async function runCommand(args) {
    const prompt = await promptFromArgs(args);
    const { extensionId } = resolveExtensionId(args);
    const homeDir = tokenlessHome(args.home);
    const config = await readTokenlessConfig(homeDir);
    const { browser } = resolveBrowser(args, config);
    const projectName = args.projectName || process.env.TOKENLESS_PROJECT_NAME;
    const chatName = args.chatName || process.env.TOKENLESS_CHAT_NAME;
    const idempotencyKey = deriveTaskId({
        projectName,
        chatName,
        idempotencyKey: args.taskId || args.idempotencyKey || process.env.TOKENLESS_TASK_ID || process.env.TOKENLESS_IDEMPOTENCY_KEY,
    });
    const provider = args.provider ||
        process.env.TOKENLESS_PROVIDER ||
        config.preferredProviders[0] ||
        'chatgpt';
    const action = args.action || 'submit_and_read';
    const readDelayMs = args.readDelayMs === undefined ? 1000 : Number(args.readDelayMs);
    const readTimeoutMs = args.readTimeoutMs === undefined ? 120000 : Number(args.readTimeoutMs);
    const metadata = {
        source: 'tokenless-cli',
        browser,
        profile: args.profile,
        projectName,
        chatName,
        idempotencyKey,
    };
    const statusReporter = createCliStatusReporter(args);
    if (!args.noDaemon) {
        const daemonResult = await tryRunWithDaemon({
            args,
            extensionId,
            provider,
            action,
            prompt,
            targetUrl: args.targetUrl,
            idempotencyKey,
            readDelayMs,
            readTimeoutMs,
            metadata,
            browser,
            projectName,
            chatName,
            statusReporter,
        });
        if (daemonResult) {
            printPayload(daemonResult, args);
            return;
        }
    }
    const job = await createLocalJob({
        homeDir,
        provider,
        action,
        prompt,
        projectRoot: args.projectRoot,
        projectName,
        chatName,
        targetUrl: args.targetUrl,
        idempotencyKey,
        readDelayMs,
        readTimeoutMs,
        metadata,
    });
    statusReporter.report({
        event: 'created',
        status: job.status,
        jobId: job.jobId,
        taskId: job.taskId,
        provider: job.provider,
        action: job.action,
        route: job.conversation?.route,
    });
    const taskUrl = buildTaskUrl({ extensionId, jobId: job.jobId, nonce: job.nonce });
    if (taskUrl && !args.noOpen) {
        await openUrl(taskUrl, { browser: browser ?? undefined });
        statusReporter.report({
            event: 'opened',
            status: 'opened_task_page',
            jobId: job.jobId,
            taskId: job.taskId,
            provider: job.provider,
            browser,
            taskUrl,
        });
    }
    else {
        statusReporter.report({
            event: 'not_opened',
            status: 'waiting_for_external_open',
            jobId: job.jobId,
            taskId: job.taskId,
            provider: job.provider,
            taskUrl,
        });
    }
    const result = args.noWait
        ? (statusReporter.report({
            event: 'detached',
            status: 'no_wait',
            jobId: job.jobId,
            taskId: job.taskId,
            provider: job.provider,
        }), null)
        : await waitLocalJobResultWithStatus({
            homeDir,
            jobId: job.jobId,
            nonce: job.nonce,
            timeoutMs: args.timeoutMs === undefined ? 180000 : Number(args.timeoutMs),
            statusReporter,
            taskId: job.taskId,
        });
    assertLocalJobSucceeded(result, statusReporter);
    const payload = {
        ok: true,
        jobId: job.jobId,
        taskId: job.taskId,
        provider: job.provider,
        taskUrl,
        requestPath: `${job.jobId}.request.json`,
        projectName: job.projectName,
        chatName: job.chatName,
        idempotencyKey: job.idempotencyKey,
        conversation: job.conversation,
        result,
        compactOutput: result?.compactOutput,
        status: result?.status ?? statusReporter.lastStatus(),
        statusLog: statusReporter.events,
    };
    printPayload(payload, args);
}
async function tryRunWithDaemon({ args, extensionId, provider, action, prompt, targetUrl, idempotencyKey, readDelayMs, readTimeoutMs, metadata, browser, projectName, chatName, statusReporter, }) {
    try {
        const job = await createDaemonJob({
            daemonUrl: args.daemonUrl,
            provider,
            action,
            requestJson: {
                requestId: idempotencyKey,
                prompt,
                targetUrl,
                idempotencyKey,
                readDelayMs,
                readTimeoutMs,
                metadata,
            },
        });
        statusReporter.report({
            event: 'daemon_created',
            status: job.status,
            jobId: job.job_id,
            provider: job.provider,
            action: job.action,
        });
        const runnerUrl = buildDaemonRunnerUrl({
            extensionId,
            daemonUrl: args.daemonUrl,
            provider,
            action,
        });
        if (!args.noOpen) {
            await openUrl(runnerUrl, { browser: browser ?? undefined });
            statusReporter.report({
                event: 'opened',
                status: 'opened_daemon_runner',
                jobId: job.job_id,
                provider,
                action,
                browser,
                runnerUrl,
            });
        }
        else {
            statusReporter.report({
                event: 'not_opened',
                status: 'waiting_for_external_daemon_runner',
                jobId: job.job_id,
                provider,
                action,
                runnerUrl,
            });
        }
        const result = args.noWait
            ? (statusReporter.report({
                event: 'detached',
                status: 'no_wait',
                jobId: job.job_id,
                provider,
                action,
            }), null)
            : await waitDaemonJobResult({
                daemonUrl: args.daemonUrl,
                jobId: job.job_id,
                timeoutMs: args.timeoutMs === undefined ? 180000 : Number(args.timeoutMs),
                onStatus: (event) => statusReporter.report(event),
            });
        assertDaemonJobSucceeded(result, statusReporter);
        return {
            ok: true,
            transport: 'daemon',
            jobId: job.job_id,
            provider,
            runnerUrl,
            projectName,
            chatName,
            idempotencyKey,
            result,
            compactOutput: result?.compactOutput,
            status: result?.status ?? statusReporter.lastStatus(),
            statusLog: statusReporter.events,
        };
    }
    catch (error) {
        const cliError = error;
        if (cliError.code !== 'daemon_unavailable') {
            throw error;
        }
        statusReporter.report({
            event: 'daemon_unavailable',
            status: 'fallback_task_page',
            taskId: idempotencyKey,
            provider,
            action,
        });
        return null;
    }
}
async function stateCommand(args) {
    const taskId = args.taskId || args.idempotencyKey || deriveTaskId({
        projectName: args.projectName || process.env.TOKENLESS_PROJECT_NAME,
        chatName: args.chatName || process.env.TOKENLESS_CHAT_NAME,
    });
    const state = await readLocalTaskState({
        homeDir: tokenlessHome(args.home),
        taskId,
        jobId: args.jobId,
        provider: args.provider || process.env.TOKENLESS_PROVIDER,
        projectName: args.projectName || process.env.TOKENLESS_PROJECT_NAME,
        chatName: args.chatName || process.env.TOKENLESS_CHAT_NAME,
        limit: args.limit === undefined ? 10 : Number(args.limit),
    });
    printPayload({
        ok: true,
        ...state,
    }, args);
}
async function installCommand(args) {
    const { extensionId } = resolveExtensionId(args);
    const homeDir = tokenlessHome(args.home);
    const config = await readTokenlessConfig(homeDir);
    const { browser } = resolveBrowser(args, config);
    const result = await installNativeHost({
        homeDir,
        extensionId,
        browsers: browser ? [browser] : undefined,
    });
    printPayload({
        ok: true,
        nativeHost: result,
        extensionInstalled: Boolean(extensionId),
        nextStep: result.manifests.length === 0
            ? 'Install the extension, then rerun with --extension-id <id>.'
            : 'Open the extension task page through tokenless run.',
    }, args);
}
async function doctorCommand(args) {
    const homeDir = tokenlessHome(args.home);
    const config = await readTokenlessConfig(homeDir);
    const nodeOk = Number(process.versions.node.split('.')[0]) >= 22;
    const { extensionId, source: extensionIdSource } = resolveExtensionId(args);
    const { browser, source: browserSource } = resolveBrowser(args, config);
    printPayload({
        ok: nodeOk && Boolean(extensionId),
        checks: {
            node: { ok: nodeOk, version: process.version, required: '>=22' },
            tokenlessHome: { ok: true, path: homeDir },
            extensionId: {
                ok: Boolean(extensionId),
                extensionId,
                source: extensionIdSource,
            },
            browser: {
                ok: true,
                browser,
                source: browserSource,
            },
        },
    }, args);
}
async function configCommand(args) {
    const homeDir = tokenlessHome(args.home);
    if (args.preferredProviders !== undefined || args.browser !== undefined) {
        const browser = args.browser === undefined ? undefined : normalizeCliBrowser(args.browser);
        const config = await writeTokenlessConfig({
            homeDir,
            preferredProviders: args.preferredProviders === undefined ? undefined : parseProviderList(args.preferredProviders),
            browser,
        });
        printPayload({
            ok: true,
            configPath: `${homeDir}/config.json`,
            config,
        }, args);
        return;
    }
    const config = await readTokenlessConfig(homeDir);
    printPayload({
        ok: true,
        configPath: `${homeDir}/config.json`,
        config,
    }, args);
}
async function promptCommand(args) {
    const prompt = await promptFromArgs(args);
    if (args.output) {
        await fs.writeFile(args.output, `${prompt}\n`, 'utf8');
    }
    else {
        console.log(prompt);
    }
}
async function promptFromArgs(args) {
    const userPrompt = args.promptFile
        ? await fs.readFile(args.promptFile, 'utf8')
        : args.prompt;
    if (!userPrompt) {
        throw usageError('missing_prompt', 'Usage: tokenless run --prompt-file <path> or --prompt <text>.');
    }
    const turnContext = args.contextFile || args.turnContextFile
        ? await fs.readFile(args.contextFile || args.turnContextFile, 'utf8')
        : args.context;
    return buildTokenlessPrompt({
        userPrompt,
        projectRoot: args.projectRoot,
        files: args.files,
        turnContext,
    });
}
function parseArgs(argv) {
    const parsed = { files: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];
        if (arg === '--prompt') {
            parsed.prompt = next;
            index += 1;
        }
        else if (arg === '--prompt-file') {
            parsed.promptFile = next;
            index += 1;
        }
        else if (arg === '--project-root') {
            parsed.projectRoot = next;
            index += 1;
        }
        else if (arg === '--project-name') {
            parsed.projectName = next;
            index += 1;
        }
        else if (arg === '--chat-name') {
            parsed.chatName = next;
            index += 1;
        }
        else if (arg === '--file') {
            if (next !== undefined) {
                parsed.files.push(next);
            }
            index += 1;
        }
        else if (arg === '--context') {
            parsed.context = next;
            index += 1;
        }
        else if (arg === '--context-file') {
            parsed.contextFile = next;
            index += 1;
        }
        else if (arg === '--turn-context') {
            parsed.context = next;
            index += 1;
        }
        else if (arg === '--turn-context-file') {
            parsed.turnContextFile = next;
            index += 1;
        }
        else if (arg === '--output') {
            parsed.output = next;
            index += 1;
        }
        else if (arg === '--provider') {
            parsed.provider = next;
            index += 1;
        }
        else if (arg === '--preferred-providers') {
            parsed.preferredProviders = next;
            index += 1;
        }
        else if (arg === '--action') {
            parsed.action = next;
            index += 1;
        }
        else if (arg === '--target-url') {
            parsed.targetUrl = next;
            index += 1;
        }
        else if (arg === '--idempotency-key' || arg === '--conversation-key') {
            parsed.idempotencyKey = next;
            index += 1;
        }
        else if (arg === '--task-id') {
            parsed.taskId = next;
            index += 1;
        }
        else if (arg === '--job-id') {
            parsed.jobId = next;
            index += 1;
        }
        else if (arg === '--limit') {
            parsed.limit = next;
            index += 1;
        }
        else if (arg === '--extension-id') {
            parsed.extensionId = next;
            index += 1;
        }
        else if (arg === '--browser') {
            parsed.browser = next;
            index += 1;
        }
        else if (arg === '--profile') {
            parsed.profile = next;
            index += 1;
        }
        else if (arg === '--home') {
            parsed.home = next;
            index += 1;
        }
        else if (arg === '--daemon-url') {
            parsed.daemonUrl = next;
            index += 1;
        }
        else if (arg === '--timeout-ms') {
            parsed.timeoutMs = next;
            index += 1;
        }
        else if (arg === '--read-delay-ms') {
            parsed.readDelayMs = next;
            index += 1;
        }
        else if (arg === '--read-timeout-ms') {
            parsed.readTimeoutMs = next;
            index += 1;
        }
        else if (arg === '--max-text-chars') {
            parsed.maxTextChars = next;
            index += 1;
        }
        else if (arg === '--include-text') {
            parsed.includeText = true;
        }
        else if (arg === '--json') {
            parsed.json = true;
        }
        else if (arg === '--quiet') {
            parsed.quiet = true;
        }
        else if (arg === '--no-open') {
            parsed.noOpen = true;
        }
        else if (arg === '--no-wait') {
            parsed.noWait = true;
        }
        else if (arg === '--no-daemon') {
            parsed.noDaemon = true;
        }
    }
    return parsed;
}
function buildDaemonRunnerUrl({ extensionId, daemonUrl, provider, action, }) {
    const params = new URLSearchParams();
    if (daemonUrl)
        params.set('daemonUrl', daemonUrl);
    if (provider)
        params.set('provider', provider);
    if (action)
        params.set('action', action);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return `chrome-extension://${extensionId}/daemon/runner.html${suffix}`;
}
async function openUrl(url, { browser } = {}) {
    const { command, args } = openCommand(url, { browser });
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'ignore', detached: true });
        child.on('error', reject);
        child.on('spawn', () => {
            child.unref();
            resolve();
        });
    });
}
function openCommand(url, { browser } = {}) {
    if (process.platform === 'darwin') {
        const app = macBrowserApp(browser, url);
        return app
            ? { command: 'open', args: ['-a', app, url] }
            : { command: 'open', args: [url] };
    }
    if (process.platform === 'win32') {
        return { command: 'cmd', args: ['/c', 'start', '', url] };
    }
    const linuxCommand = linuxBrowserCommand(browser);
    if (linuxCommand) {
        return { command: linuxCommand, args: [url] };
    }
    return { command: 'xdg-open', args: [url] };
}
function macBrowserApp(browser, url) {
    const normalized = normalizeBrowserId(browser);
    if (normalized === 'arc')
        return 'Arc';
    if (normalized === 'edge')
        return 'Microsoft Edge';
    if (normalized === 'brave')
        return 'Brave Browser';
    if (normalized === 'chrome')
        return 'Google Chrome';
    if (normalized === 'chrome-for-testing' || normalized === 'chrome-for-testing-legacy')
        return 'Google Chrome for Testing';
    if (normalized === 'chromium')
        return 'Chromium';
    if (url.startsWith('chrome-extension://'))
        return 'Google Chrome';
    return null;
}
function linuxBrowserCommand(browser) {
    const normalized = normalizeBrowserId(browser);
    if (normalized === 'chrome')
        return 'google-chrome';
    if (normalized === 'chrome-for-testing' || normalized === 'chrome-for-testing-legacy')
        return 'google-chrome-for-testing';
    if (normalized === 'chromium')
        return 'chromium';
    if (normalized === 'edge')
        return 'microsoft-edge';
    if (normalized === 'brave')
        return 'brave-browser';
    return null;
}
function printPayload(payload, args) {
    if (args.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
    }
    if (payload.compactOutput) {
        console.log(payload.compactOutput);
        return;
    }
    console.log(JSON.stringify(payload, null, 2));
}
async function waitLocalJobResultWithStatus({ homeDir, jobId, nonce, timeoutMs, statusReporter, taskId, }) {
    try {
        return await waitLocalJobResult({
            homeDir,
            jobId,
            nonce,
            timeoutMs,
            onStatus: (event) => statusReporter.report({ ...event, taskId }),
        });
    }
    catch (error) {
        const cliError = error;
        cliError.status = statusReporter.lastStatus();
        cliError.statusLog = statusReporter.events;
        throw cliError;
    }
}
function assertLocalJobSucceeded(result, statusReporter) {
    if (!result || result.ok !== false) {
        return;
    }
    const error = new Error(result.error?.message || `Local Tokenless job failed: ${result.status || 'failed'}`);
    error.code = result.error?.code || result.status || 'local_job_failed';
    error.retryable = Boolean(result.error?.retryable);
    error.status = result.status ?? statusReporter.lastStatus();
    error.statusLog = statusReporter.events;
    throw error;
}
function assertDaemonJobSucceeded(result, statusReporter) {
    if (!result || result.ok !== false) {
        return;
    }
    const errorPayload = result.error && typeof result.error === 'object'
        ? result.error
        : {};
    const error = new Error(String(errorPayload.message || `Daemon Tokenless job failed: ${result.status || 'failed'}`));
    error.code = String(errorPayload.code || result.status || 'daemon_job_failed');
    error.retryable = Boolean(errorPayload.retryable);
    error.status = result.status ?? statusReporter.lastStatus();
    error.statusLog = statusReporter.events;
    throw error;
}
function createCliStatusReporter(args) {
    const startedAt = Date.now();
    const events = [];
    const report = (event) => {
        const normalized = normalizeStatusEvent(event, startedAt);
        events.push(normalized);
        if (!args.json && !args.quiet) {
            console.log(formatStatusEvent(normalized));
        }
    };
    return {
        events,
        report,
        lastStatus() {
            return events.at(-1)?.status;
        },
    };
}
function normalizeStatusEvent(event, startedAt) {
    const now = new Date();
    const elapsedMs = Number.isFinite(event.elapsedMs) ? event.elapsedMs : now.getTime() - startedAt;
    return {
        at: now.toISOString(),
        event: event.event || event.type || 'status',
        status: event.status,
        jobId: event.jobId,
        taskId: event.taskId,
        provider: event.provider ?? event.detail?.provider,
        action: event.action,
        route: event.route,
        actor: event.actor,
        browser: event.browser,
        taskUrl: event.taskUrl,
        runnerUrl: event.runnerUrl,
        elapsedMs,
    };
}
function formatStatusEvent(event) {
    const parts = ['[tokenless]', event.event];
    for (const [key, value] of [
        ['status', event.status],
        ['provider', event.provider],
        ['action', event.action],
        ['route', event.route],
        ['taskId', event.taskId],
        ['actor', event.actor],
        ['browser', event.browser],
        ['elapsed', formatElapsed(event.elapsedMs)],
    ]) {
        if (value !== undefined && value !== null && value !== '') {
            parts.push(`${key}=${formatStatusValue(value)}`);
        }
    }
    if (event.jobId) {
        parts.push(`job=${shortJobId(event.jobId)}`);
    }
    if (event.taskUrl && (event.event === 'opened' || event.event === 'not_opened')) {
        parts.push(`taskUrl=${event.taskUrl}`);
    }
    if (event.runnerUrl && (event.event === 'opened' || event.event === 'not_opened')) {
        parts.push(`runnerUrl=${event.runnerUrl}`);
    }
    return parts.join(' ');
}
function formatStatusValue(value) {
    const text = String(value);
    return /\s/.test(text) ? JSON.stringify(text) : text;
}
function formatElapsed(elapsedMs) {
    const value = Number(elapsedMs);
    if (!Number.isFinite(value))
        return undefined;
    return `${Math.max(0, Math.round(value / 1000))}s`;
}
function shortJobId(jobId) {
    return String(jobId).slice(0, 8);
}
function usage() {
    console.error([
        'Usage:',
        '  tokenless run --provider chatgpt --project-name <agent-project> --chat-name <agent-chat> --project-root <path> --prompt-file <file> --context-file <file> --json',
        '  tokenless state --task-id <task-id> --json',
        '  tokenless snapshot-dom --provider chatgpt --extension-id <chrome-extension-id> --json',
        '  tokenless config --preferred-providers claude,chatgpt,gemini --browser brave --json',
        '  tokenless install --extension-id <chrome-extension-id> --json',
        '  tokenless doctor --json',
    ].join('\n'));
}
function usageError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}
function resolveExtensionId(args) {
    const candidates = [
        ['argument', args.extensionId],
        ['environment', process.env.TOKENLESS_EXTENSION_ID],
        ['bundled_default', DEFAULT_EXTENSION_ID],
    ];
    for (const [source, value] of candidates) {
        if (!value)
            continue;
        const extensionId = normalizeExtensionId(value);
        if (!extensionId) {
            throw usageError('invalid_extension_id', 'Extension id must be the real 32-character Chrome extension id from chrome://extensions.');
        }
        return { extensionId, source };
    }
    throw usageError('missing_extension_id', 'Usage: tokenless requires --extension-id <id>, TOKENLESS_EXTENSION_ID, or a bundled default extension id.');
}
function resolveBrowser(args, config = {}) {
    if (args.browser !== undefined) {
        return { browser: normalizeCliBrowser(args.browser), source: 'argument' };
    }
    if (config.browser) {
        return { browser: normalizeCliBrowser(config.browser), source: 'config' };
    }
    return { browser: null, source: 'default' };
}
function normalizeCliBrowser(browser) {
    const browserId = normalizeBrowserId(browser);
    if (!browserId) {
        throw usageError('invalid_browser', 'Browser must be one of: chrome, chrome-for-testing, chromium, edge, arc, brave.');
    }
    return browserId;
}
function normalizeExtensionId(extensionId) {
    if (typeof extensionId !== 'string')
        return null;
    const normalized = extensionId.trim().toLowerCase();
    return /^[a-p]{32}$/.test(normalized) ? normalized : null;
}
function parseProviderList(value) {
    return String(value)
        .split(',')
        .map((provider) => provider.trim())
        .filter(Boolean);
}
//# sourceMappingURL=tokenless.mjs.map