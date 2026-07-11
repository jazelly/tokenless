#!/usr/bin/env node
import fs from 'node:fs/promises';
import { DEFAULT_DAEMON_URL, MAX_NATIVE_MESSAGE_BYTES, NATIVE_PROTOCOL, buildTokenlessPrompt, cancelDaemonJob, createDaemonJob, daemonUrl, deriveTaskId, ensureDaemonReady, getDaemonJob, inspectNativeHostManifests, inspectRustBinaries, installRustRuntime, listDaemonJobs, normalizeBrowserId, openProviderUrl, persistDaemonSnapshot, providerWakeUrl, readLiveBridgeMarker, readTokenlessConfig, refreshInstalledRustBinaries, resolveChromiumBrowser, tokenlessHome, waitDaemonJobResult, waitForExtensionBridge, writeTokenlessConfig, } from './index.js';
import { DEFAULT_EXTENSION_ID } from './default-extension-id.js';
let args = { files: [], json: process.argv.includes('--json') };
try {
    const argv = process.argv.slice(2);
    const command = argv[0]?.startsWith('-') ? 'prompt' : (argv.shift() ?? 'help');
    args = parseArgs(argv);
    if (command === 'run') {
        await runCommand(args);
    }
    else if (command === 'chatgpt-controls' || command === 'inspect-chatgpt-controls') {
        await chatGptControlsCommand(args);
    }
    else if (command === 'chatgpt-configure') {
        await chatGptConfigureCommand(args);
    }
    else if (command === 'snapshot-dom') {
        await snapshotDomCommand(args);
    }
    else if (command === 'state' || command === 'status') {
        await stateCommand(args);
    }
    else if (command === 'cancel') {
        await cancelCommand(args);
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
    if (cliError.status)
        payload.status = cliError.status;
    if (Array.isArray(cliError.statusLog))
        payload.statusLog = cliError.statusLog;
    if (args.json)
        console.log(JSON.stringify(payload, null, 2));
    else
        console.error(`${payload.error.code}: ${payload.error.message}`);
    process.exit(1);
}
async function runCommand(args) {
    const prompt = await promptFromArgs(args);
    await executeDaemonJob({ args, action: args.action || 'submit_and_read', prompt });
}
async function chatGptControlsCommand(args) {
    await executeDaemonJob({
        args: { ...args, provider: requiredChatGptProvider(args) },
        action: 'inspect_chatgpt_controls',
    });
}
async function chatGptConfigureCommand(args) {
    if (args.model === undefined && args.effort === undefined && args.thinkingEffort === undefined && args.chatSurface === undefined) {
        throw usageError('missing_chatgpt_control', 'chatgpt-configure requires --model, --effort, or --chat-surface chat.');
    }
    await executeDaemonJob({
        args: { ...args, provider: requiredChatGptProvider(args) },
        action: 'configure_chatgpt',
    });
}
async function snapshotDomCommand(args) {
    await executeDaemonJob({ args, action: 'snapshot_dom' });
}
async function executeDaemonJob({ args, action, prompt, }) {
    const homeDir = tokenlessHome(args.home);
    const config = await readTokenlessConfig(homeDir);
    const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined);
    const provider = normalizeProvider(args.provider || process.env.TOKENLESS_PROVIDER || config.preferredProviders[0] || 'chatgpt');
    const chatGptControls = resolveChatGptControls({ args, provider, action });
    const projectName = args.projectName || process.env.TOKENLESS_PROJECT_NAME;
    const chatName = args.chatName || process.env.TOKENLESS_CHAT_NAME || (action === 'snapshot_dom' ? 'DOM snapshot' : undefined);
    const taskId = deriveTaskId({
        projectName,
        chatName,
        idempotencyKey: args.taskId || args.idempotencyKey || process.env.TOKENLESS_TASK_ID || process.env.TOKENLESS_IDEMPOTENCY_KEY,
    });
    const statusReporter = createCliStatusReporter(args);
    try {
        const daemon = await ensureDaemonReady({
            homeDir,
            daemonUrl: configuredDaemonUrl,
            timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
        });
        statusReporter.report({
            event: daemon.started ? 'daemon_started' : 'daemon_ready',
            status: 'ready',
            daemonUrl: configuredDaemonUrl,
            daemonPid: daemon.pid,
        });
        await writeTokenlessConfig({ homeDir, daemonUrl: configuredDaemonUrl });
        const targetUrl = args.targetUrl
            ? providerWakeUrl(provider, args.targetUrl)
            : await mappedDaemonTarget({ homeDir, daemonUrl: configuredDaemonUrl, provider, taskId }) ?? providerWakeUrl(provider);
        const selectedBrowser = args.browser ?? config.browser ?? undefined;
        const bridge = await prepareExtensionBridge({
            args,
            homeDir,
            provider,
            targetUrl,
            selectedBrowser,
            statusReporter,
        });
        const readDelayMs = args.readDelayMs === undefined ? 1000 : Number(args.readDelayMs);
        const readTimeoutMs = args.readTimeoutMs === undefined ? 120000 : Number(args.readTimeoutMs);
        const requestJson = {
            requestId: taskId,
            taskId,
            prompt,
            targetUrl,
            idempotencyKey: taskId,
            readDelayMs,
            readTimeoutMs,
            includeText: action === 'snapshot_dom' ? Boolean(args.includeText) : undefined,
            maxTextChars: action === 'snapshot_dom' && args.maxTextChars !== undefined
                ? Number(args.maxTextChars)
                : undefined,
            ...chatGptControls,
            metadata: {
                source: 'tokenless-cli',
                browser: bridge.browser ?? normalizeBrowserId(selectedBrowser),
                projectName,
                chatName,
                taskId,
                idempotencyKey: taskId,
                visibleSessionOnly: true,
            },
        };
        assertNativeRequestSize({ provider, action, request_json: requestJson });
        const job = await createDaemonJob({
            daemonUrl: configuredDaemonUrl,
            homeDir,
            provider,
            action,
            requestJson,
        });
        statusReporter.report({
            event: 'daemon_created',
            status: job.status,
            jobId: job.job_id,
            taskId,
            provider,
            action,
        });
        const result = args.noWait
            ? (statusReporter.report({
                event: 'detached',
                status: 'no_wait',
                jobId: job.job_id,
                taskId,
                provider,
                action,
            }), null)
            : await waitForJobWithInterruptCancellation({
                homeDir,
                daemonUrl: configuredDaemonUrl,
                jobId: job.job_id,
                timeoutMs: args.timeoutMs === undefined
                    ? (action === 'snapshot_dom' ? 60_000 : 180_000)
                    : Number(args.timeoutMs),
                cancelTimeoutMs: optionalNumber(args.cancelTimeoutMs),
                statusReporter,
            });
        assertDaemonJobSucceeded(result, statusReporter);
        if (action === 'snapshot_dom' && result) {
            const snapshot = await persistDaemonSnapshot({
                homeDir,
                jobId: job.job_id,
                provider,
                result: result.result,
            });
            printPayload({
                ok: true,
                transport: 'daemon',
                jobId: job.job_id,
                taskId,
                provider,
                snapshot,
                compactOutput: snapshot.metadataPath,
                status: result.status,
                statusLog: statusReporter.events,
            }, args);
            return;
        }
        printPayload({
            ok: true,
            transport: 'daemon',
            jobId: job.job_id,
            taskId,
            provider,
            projectName,
            chatName,
            idempotencyKey: taskId,
            result: publicDaemonResult(result),
            compactOutput: result?.compactOutput,
            status: result?.status ?? statusReporter.lastStatus(),
            statusLog: statusReporter.events,
        }, args);
    }
    catch (error) {
        attachStatusLog(error, statusReporter);
        throw error;
    }
}
async function prepareExtensionBridge({ args, homeDir, provider, targetUrl, selectedBrowser, statusReporter, }) {
    const existing = await readLiveBridgeMarker({ homeDir });
    if (existing) {
        statusReporter.report({
            event: 'bridge_ready',
            status: 'ready',
            provider,
            bridgeSession: existing.sessionId,
        });
        return { marker: existing, browser: normalizeBrowserId(selectedBrowser), opened: false };
    }
    statusReporter.report({ event: 'bridge_missing', status: 'not_ready', provider });
    if (args.noOpen) {
        throw usageError('extension_bridge_unavailable', 'No live Tokenless extension bridge is connected. Remove --no-open so Tokenless can open only the selected provider page, or open that provider in the configured Chromium browser first.');
    }
    const browser = await resolveChromiumBrowser(selectedBrowser);
    await openProviderUrl(targetUrl, browser);
    statusReporter.report({
        event: 'provider_opened',
        status: 'waiting_for_bridge',
        provider,
        browser: browser.browser,
        providerUrl: targetUrl,
    });
    await writeTokenlessConfig({ homeDir, browser: browser.browser });
    const marker = await waitForExtensionBridge({
        homeDir,
        timeoutMs: args.bridgeTimeoutMs === undefined ? undefined : Number(args.bridgeTimeoutMs),
    });
    statusReporter.report({
        event: 'bridge_ready',
        status: 'ready',
        provider,
        browser: browser.browser,
        bridgeSession: marker.sessionId,
    });
    return { marker, browser: browser.browser, opened: true };
}
async function stateCommand(args) {
    const homeDir = tokenlessHome(args.home);
    const config = await readTokenlessConfig(homeDir);
    const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined);
    await ensureDaemonReady({
        homeDir,
        daemonUrl: configuredDaemonUrl,
        timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
    });
    const requestedTaskId = args.taskId || args.idempotencyKey || deriveTaskId({
        projectName: args.projectName || process.env.TOKENLESS_PROJECT_NAME,
        chatName: args.chatName || process.env.TOKENLESS_CHAT_NAME,
    });
    if (!requestedTaskId && !args.jobId) {
        throw usageError('missing_task_id', 'Usage: tokenless state requires --task-id or --job-id.');
    }
    const providerValue = args.provider || process.env.TOKENLESS_PROVIDER || (args.jobId ? undefined : config.preferredProviders[0] || 'chatgpt');
    const provider = providerValue ? normalizeProvider(providerValue) : undefined;
    const daemonJobs = args.jobId
        ? [await getDaemonJob({ daemonUrl: configuredDaemonUrl, homeDir, jobId: args.jobId })]
        : await listDaemonJobs({
            daemonUrl: configuredDaemonUrl,
            homeDir,
            taskId: requestedTaskId,
            provider,
            limit: Math.max(1, Number(args.limit) || 10),
        });
    const jobs = daemonJobs
        .map(publicDaemonJobState)
        .filter((job) => {
        if (requestedTaskId && job.taskId !== requestedTaskId)
            return false;
        if (provider && job.provider !== provider)
            return false;
        return true;
    })
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    if (jobs.length === 0) {
        throw usageError('task_state_not_found', `No daemon-backed Tokenless task state found for ${requestedTaskId ?? args.jobId}.`);
    }
    const latest = jobs[0];
    printPayload({
        ok: true,
        protocol: 'tokenless.daemon-task-state.v1',
        transport: 'daemon',
        taskId: requestedTaskId ?? latest.taskId,
        provider: provider ?? latest.provider,
        latest,
        jobs: jobs.slice(0, Math.max(1, Number(args.limit) || 10)),
    }, args);
}
async function cancelCommand(args) {
    if (!args.jobId)
        throw usageError('missing_job_id', 'Usage: tokenless cancel --job-id <job-id>.');
    const homeDir = tokenlessHome(args.home);
    const config = await readTokenlessConfig(homeDir);
    const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined);
    await ensureDaemonReady({
        homeDir,
        daemonUrl: configuredDaemonUrl,
        timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
    });
    let job;
    try {
        job = await cancelDaemonJob({
            homeDir,
            daemonUrl: configuredDaemonUrl,
            jobId: args.jobId,
            reason: { code: 'user_requested' },
            requestTimeoutMs: optionalNumber(args.cancelTimeoutMs),
        });
    }
    catch (error) {
        throw cancelFailure(args.jobId, error);
    }
    if (job.status !== 'canceled') {
        throw cancelFailure(args.jobId, new Error(`daemon returned status ${String(job.status)}`));
    }
    printPayload({
        ok: true,
        transport: 'daemon',
        jobId: job.job_id,
        status: job.status,
        error: job.error_json,
    }, args);
}
async function installCommand(args) {
    const homeDir = tokenlessHome(args.home);
    const config = await readTokenlessConfig(homeDir);
    const { extensionId, source: extensionIdSource } = resolveInstallExtensionId(args);
    const requestedBrowsers = args.browsers === undefined
        ? [args.browser ?? config.browser ?? undefined]
        : parseList(args.browsers);
    const resolvedBrowsers = [];
    for (const requested of requestedBrowsers) {
        const browser = await resolveChromiumBrowser(requested);
        if (!resolvedBrowsers.includes(browser.browser))
            resolvedBrowsers.push(browser.browser);
    }
    const installed = await installRustRuntime({
        homeDir,
        manifestHome: args.manifestHome,
        extensionId,
        browsers: resolvedBrowsers,
    });
    const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined);
    await writeTokenlessConfig({
        homeDir,
        browser: resolvedBrowsers[0],
        daemonUrl: configuredDaemonUrl,
    });
    const daemon = await ensureDaemonReady({
        homeDir,
        daemonUrl: configuredDaemonUrl,
        timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
    });
    printPayload({
        ok: true,
        runtime: 'rust',
        extensionIdSource,
        browser: resolvedBrowsers[0],
        browsers: resolvedBrowsers,
        daemon: {
            ready: true,
            started: daemon.started,
            url: configuredDaemonUrl,
            pid: daemon.pid,
            executable: installed.daemonExecutable,
        },
        nativeHost: {
            runtime: 'rust',
            protocol: NATIVE_PROTOCOL,
            executable: installed.nativeHostExecutable,
            manifests: installed.manifests,
            registryCommands: installed.registryCommands,
            allowedOrigin: installed.allowedOrigin,
        },
        nextStep: 'Keep the Tokenless extension enabled. Run npx tokenless run; it opens only the selected provider UI when the bridge needs waking.',
    }, args);
}
async function doctorCommand(args) {
    const homeDir = tokenlessHome(args.home);
    let runtimeRefresh;
    try {
        const refreshed = await refreshInstalledRustBinaries({ homeDir });
        runtimeRefresh = { ok: true, refreshed };
    }
    catch (error) {
        runtimeRefresh = { ok: false, refreshed: [], message: error instanceof Error ? error.message : String(error) };
    }
    let config = { preferredProviders: [], browser: null, daemonUrl: null };
    let configCheck;
    try {
        config = await readTokenlessConfig(homeDir);
        configCheck = { ok: true, path: `${homeDir}/config.json`, value: config };
    }
    catch (error) {
        configCheck = {
            ok: false,
            path: `${homeDir}/config.json`,
            message: error instanceof Error ? error.message : String(error),
        };
    }
    let configuredDaemonUrl = DEFAULT_DAEMON_URL;
    let daemonUrlCheck;
    try {
        configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined);
        daemonUrlCheck = { ok: true, url: configuredDaemonUrl };
    }
    catch (error) {
        daemonUrlCheck = {
            ok: false,
            url: args.daemonUrl ?? config.daemonUrl,
            message: error instanceof Error ? error.message : String(error),
        };
    }
    const browserId = args.browser ?? config.browser ?? undefined;
    const binaries = await inspectRustBinaries(homeDir);
    const manifests = await inspectNativeHostManifests({
        homeDir,
        manifestHome: args.manifestHome,
        browsers: browserId ? [String(browserId)] : ['chrome'],
    });
    const bridge = await readLiveBridgeMarker({ homeDir });
    let browser;
    try {
        const resolved = await resolveChromiumBrowser(browserId);
        browser = { ok: true, id: resolved.browser, displayName: resolved.displayName };
    }
    catch (error) {
        browser = { ok: false, id: normalizeBrowserId(browserId), message: error.message };
    }
    let daemon;
    try {
        const ready = await ensureDaemonReady({
            homeDir,
            daemonUrl: configuredDaemonUrl,
            timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
        });
        daemon = {
            ok: true,
            ready: true,
            url: configuredDaemonUrl,
            homeDir: ready.actualHome,
            daemonProtocol: ready.body?.daemon_protocol,
            nativeProtocol: ready.body?.native_protocol,
            version: ready.body?.version,
            pid: ready.pid,
        };
    }
    catch (error) {
        daemon = { ok: false, ready: false, url: configuredDaemonUrl, message: error.message };
    }
    const nodeOk = Number(process.versions.node.split('.')[0]) >= 22;
    const checks = {
        node: { ok: nodeOk, version: process.version, required: '>=22' },
        tokenlessHome: { ok: true, path: homeDir },
        runtimeRefresh,
        rustBinaries: binaries,
        daemon,
        nativeHostManifests: manifests,
        browser,
        config: configCheck,
        daemonUrlConfiguration: daemonUrlCheck,
        extensionBridge: bridge
            ? { ok: true, path: bridge.path, protocol: bridge.protocol, pid: bridge.pid, sessionId: bridge.sessionId, heartbeatAgeMs: bridge.heartbeatAgeMs }
            : { ok: false, status: 'not_connected', message: 'Open the configured provider page to wake the extension bridge.' },
    };
    const ok = Object.values(checks).every((check) => check.ok === true);
    printPayload({
        ok,
        runtime: 'rust',
        checks,
    }, args);
    if (!ok)
        process.exitCode = 1;
}
async function configCommand(args) {
    const homeDir = tokenlessHome(args.home);
    if (args.preferredProviders !== undefined || args.browser !== undefined || args.daemonUrl !== undefined) {
        const browser = args.browser === undefined ? undefined : normalizeCliBrowser(args.browser);
        const config = await writeTokenlessConfig({
            homeDir,
            preferredProviders: args.preferredProviders === undefined ? undefined : parseProviderList(args.preferredProviders),
            browser,
            daemonUrl: args.daemonUrl === undefined ? undefined : daemonUrl(args.daemonUrl),
        });
        printPayload({ ok: true, configPath: `${homeDir}/config.json`, config }, args);
        return;
    }
    const config = await readTokenlessConfig(homeDir);
    printPayload({ ok: true, configPath: `${homeDir}/config.json`, config }, args);
}
async function promptCommand(args) {
    const prompt = await promptFromArgs(args);
    if (args.output)
        await fs.writeFile(args.output, `${prompt}\n`, 'utf8');
    else
        console.log(prompt);
}
async function promptFromArgs(args) {
    const userPrompt = args.promptFile ? await fs.readFile(args.promptFile, 'utf8') : args.prompt;
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
async function mappedDaemonTarget({ homeDir, daemonUrl, provider, taskId, }) {
    if (!taskId)
        return null;
    const jobs = await listDaemonJobs({ homeDir, daemonUrl, provider, taskId, limit: 1000 });
    for (const job of jobs) {
        if (job.provider !== provider || daemonTaskId(job) !== taskId)
            continue;
        const candidate = resultUrl(job.result_json);
        if (!candidate)
            continue;
        try {
            return providerWakeUrl(provider, candidate);
        }
        catch {
            // Never open an untrusted URL recovered from job metadata.
        }
    }
    return null;
}
function publicDaemonJobState(job) {
    const request = objectRecord(job.request_json);
    const metadata = objectRecord(request.metadata);
    return {
        jobId: job.job_id,
        taskId: daemonTaskId(job),
        provider: job.provider,
        action: job.action,
        projectName: metadata.projectName,
        chatName: metadata.chatName,
        targetUrl: safeStateTarget(job.provider, request.targetUrl),
        createdAt: job.created_at,
        updatedAt: job.updated_at,
        status: job.status,
        state: {
            status: job.status,
            actor: 'tokenless-daemon',
            updatedAt: job.updated_at,
            error: job.error_json,
        },
        result: job.result_json === null && job.error_json === null
            ? null
            : { ok: job.status === 'succeeded', value: job.result_json, error: job.error_json },
        error: job.error_json,
    };
}
function daemonTaskId(job) {
    const request = objectRecord(job.request_json);
    const metadata = objectRecord(request.metadata);
    const value = request.taskId ?? request.idempotencyKey ?? request.requestId ?? metadata.taskId ?? metadata.idempotencyKey;
    return typeof value === 'string' ? value : undefined;
}
function safeStateTarget(provider, value) {
    if (typeof value !== 'string')
        return undefined;
    try {
        return providerWakeUrl(provider, value);
    }
    catch {
        return undefined;
    }
}
function resultUrl(value) {
    if (!value || typeof value !== 'object')
        return null;
    const result = value;
    const candidate = result.read?.url ?? result.url ?? result.textUrl ?? result.submit?.url ?? result.result?.read?.url ?? result.result?.url;
    return typeof candidate === 'string' ? candidate : null;
}
async function waitForJobWithInterruptCancellation({ homeDir, daemonUrl, jobId, timeoutMs, cancelTimeoutMs, statusReporter, }) {
    let interrupted = false;
    let interruptReject;
    const interrupt = new Promise((_resolve, reject) => { interruptReject = reject; });
    const waitAbort = new AbortController();
    const neverSettles = new Promise(() => undefined);
    const onSignal = (signal) => {
        if (interrupted)
            return;
        interrupted = true;
        waitAbort.abort();
        statusReporter.report({ event: 'cancel_requested', status: 'canceling', jobId, signal });
        void cancelDaemonJob({
            homeDir,
            daemonUrl,
            jobId,
            reason: { code: 'signal', signal },
            requestTimeoutMs: cancelTimeoutMs,
        })
            .then((job) => {
            if (job.status !== 'canceled')
                throw new Error(`daemon returned status ${job.status}`);
            statusReporter.report({ event: 'cancel_confirmed', status: 'canceled', jobId, signal });
            const error = usageError('job_interrupted', `Tokenless job ${jobId} cancellation was confirmed after ${signal}.`);
            error.retryable = true;
            interruptReject?.(error);
        })
            .catch((cancelError) => {
            statusReporter.report({ event: 'cancel_failed', status: 'may_still_be_running', jobId, signal });
            interruptReject?.(cancelFailure(jobId, cancelError, signal));
        });
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
        const guardedWait = waitDaemonJobResult({
            homeDir,
            daemonUrl,
            jobId,
            timeoutMs,
            signal: waitAbort.signal,
            onStatus: (event) => statusReporter.report(event),
        }).then((result) => interrupted ? neverSettles : result, (error) => interrupted ? neverSettles : Promise.reject(error));
        return await Promise.race([
            guardedWait,
            interrupt,
        ]);
    }
    finally {
        waitAbort.abort();
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
    }
}
function cancelFailure(jobId, cause, signal) {
    const context = signal ? ` after ${signal}` : '';
    const detail = cause instanceof Error && cause.message ? ` ${cause.message}` : '';
    const error = usageError('job_cancel_failed', `Cancellation was not confirmed for Tokenless job ${jobId}${context}; the job may still be running or may already have completed.${detail}`);
    error.retryable = true;
    return error;
}
function assertDaemonJobSucceeded(result, statusReporter) {
    if (!result || result.ok !== false)
        return;
    const errorPayload = objectRecord(result.error);
    const error = new Error(String(errorPayload.message || `Daemon Tokenless job failed: ${result.status || 'failed'}`));
    error.code = String(errorPayload.code || result.status || 'daemon_job_failed');
    error.retryable = Boolean(errorPayload.retryable);
    error.status = result.status ?? statusReporter.lastStatus();
    error.statusLog = statusReporter.events;
    throw error;
}
function publicDaemonResult(result) {
    if (!result)
        return null;
    return {
        ok: result.ok,
        status: result.status,
        result: result.result,
        error: result.error,
    };
}
function assertNativeRequestSize(value) {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes <= MAX_NATIVE_MESSAGE_BYTES)
        return;
    throw usageError('native_message_too_large', `Tokenless request is ${bytes} bytes; keep it below ${MAX_NATIVE_MESSAGE_BYTES} bytes so Chrome native messaging can deliver it. Attach fewer or smaller files.`);
}
function parseArgs(argv) {
    const parsed = { files: [] };
    const valueFlags = {
        '--prompt': 'prompt',
        '--prompt-file': 'promptFile',
        '--project-root': 'projectRoot',
        '--project-name': 'projectName',
        '--chat-name': 'chatName',
        '--context': 'context',
        '--context-file': 'contextFile',
        '--turn-context': 'context',
        '--turn-context-file': 'turnContextFile',
        '--output': 'output',
        '--provider': 'provider',
        '--preferred-providers': 'preferredProviders',
        '--action': 'action',
        '--target-url': 'targetUrl',
        '--idempotency-key': 'idempotencyKey',
        '--conversation-key': 'idempotencyKey',
        '--task-id': 'taskId',
        '--job-id': 'jobId',
        '--limit': 'limit',
        '--extension-id': 'extensionId',
        '--browser': 'browser',
        '--browsers': 'browsers',
        '--manifest-home': 'manifestHome',
        '--home': 'home',
        '--daemon-url': 'daemonUrl',
        '--timeout-ms': 'timeoutMs',
        '--daemon-start-timeout-ms': 'daemonStartTimeoutMs',
        '--cancel-timeout-ms': 'cancelTimeoutMs',
        '--bridge-timeout-ms': 'bridgeTimeoutMs',
        '--read-delay-ms': 'readDelayMs',
        '--read-timeout-ms': 'readTimeoutMs',
        '--max-text-chars': 'maxTextChars',
        '--model': 'model',
        '--model-fallback': 'modelFallbacks',
        '--effort': 'effort',
        '--thinking-effort': 'thinkingEffort',
        '--chat-surface': 'chatSurface',
    };
    const booleanFlags = {
        '--include-text': 'includeText',
        '--json': 'json',
        '--quiet': 'quiet',
        '--no-open': 'noOpen',
        '--no-wait': 'noWait',
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--file') {
            const value = requireFlagValue(argv, index, arg);
            parsed.files.push(value);
            index += 1;
            continue;
        }
        const key = valueFlags[arg];
        if (key) {
            parsed[key] = requireFlagValue(argv, index, arg);
            index += 1;
            continue;
        }
        const booleanKey = booleanFlags[arg];
        if (booleanKey) {
            parsed[booleanKey] = true;
            continue;
        }
        throw usageError(arg === '--no-daemon' ? 'daemon_only' : 'unknown_argument', arg === '--no-daemon'
            ? 'Tokenless is daemon-only; --no-daemon and local task-page fallback were removed.'
            : `Unknown Tokenless argument: ${arg}`);
    }
    return parsed;
}
function requireFlagValue(argv, index, flag) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
        throw usageError('missing_argument_value', `${flag} requires a value.`);
    }
    return value;
}
function resolveInstallExtensionId(args) {
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
    throw usageError('missing_extension_id', 'Tokenless install needs a Chrome extension id.');
}
function normalizeExtensionId(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim().toLowerCase();
    return /^[a-p]{32}$/.test(normalized) ? normalized : null;
}
function normalizeCliBrowser(browser) {
    const browserId = normalizeBrowserId(browser);
    if (!browserId || browserId === 'profile') {
        throw usageError('invalid_browser', 'Browser must be one of: chrome, chrome-for-testing, chromium, edge, arc, brave.');
    }
    return browserId;
}
function normalizeProvider(provider) {
    const normalized = String(provider).trim().toLowerCase();
    if (!['chatgpt', 'claude', 'gemini'].includes(normalized)) {
        throw usageError('unsupported_provider', 'Provider must be one of: chatgpt, claude, gemini.');
    }
    return normalized;
}
function requiredChatGptProvider(args) {
    if (args.provider !== undefined && normalizeProvider(args.provider) !== 'chatgpt') {
        throw usageError('chatgpt_controls_unsupported', 'ChatGPT controls require --provider chatgpt or no provider argument.');
    }
    return 'chatgpt';
}
function resolveChatGptControls({ args, provider, action, }) {
    const hasRequestedControl = (args.model !== undefined ||
        args.modelFallbacks !== undefined ||
        args.effort !== undefined ||
        args.thinkingEffort !== undefined ||
        args.chatSurface !== undefined);
    if (provider !== 'chatgpt') {
        if (hasRequestedControl) {
            throw usageError('chatgpt_controls_unsupported', '--model, --model-fallback, --effort, and --chat-surface are available only for ChatGPT.');
        }
        return {};
    }
    if (action === 'inspect_chatgpt_controls')
        return {};
    const chatSurface = args.chatSurface === undefined ? 'chat' : String(args.chatSurface).trim().toLowerCase();
    if (chatSurface !== 'chat') {
        throw usageError('invalid_chat_surface', 'ChatGPT runs support only --chat-surface chat; Work is intentionally not used by Tokenless.');
    }
    const effortValue = args.effort ?? args.thinkingEffort;
    const effort = effortValue === undefined ? undefined : normalizeChatGptEffort(effortValue);
    return {
        chatSurface,
        model: args.model === undefined ? undefined : String(args.model).trim(),
        modelFallbacks: args.modelFallbacks === undefined ? undefined : parseList(args.modelFallbacks),
        effort,
    };
}
function normalizeChatGptEffort(value) {
    const normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!['instant', 'medium', 'high', 'extra_high', 'pro'].includes(normalized)) {
        throw usageError('invalid_effort', '--effort must be one of: instant, medium, high, extra_high, pro.');
    }
    return normalized;
}
function parseProviderList(value) {
    return parseList(value).map(normalizeProvider);
}
function parseList(value) {
    return [...new Set(String(value).split(',').map((entry) => entry.trim()).filter(Boolean))];
}
function createCliStatusReporter(args) {
    const startedAt = Date.now();
    const events = [];
    const report = (event) => {
        const normalized = normalizeStatusEvent(event, startedAt);
        events.push(normalized);
        if (!args.json && !args.quiet)
            console.log(formatStatusEvent(normalized));
    };
    return { events, report, lastStatus: () => events.at(-1)?.status };
}
function normalizeStatusEvent(event, startedAt) {
    const now = new Date();
    return {
        at: now.toISOString(),
        event: event.event || event.type || 'status',
        status: event.status,
        jobId: event.jobId,
        taskId: event.taskId,
        provider: event.provider ?? event.detail?.provider,
        action: event.action,
        browser: event.browser,
        providerUrl: event.providerUrl,
        daemonUrl: event.daemonUrl,
        daemonPid: event.daemonPid,
        bridgeSession: event.bridgeSession,
        actor: event.actor,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        retryable: event.retryable,
        elapsedMs: Number.isFinite(event.elapsedMs) ? event.elapsedMs : now.getTime() - startedAt,
    };
}
function formatStatusEvent(event) {
    const parts = ['[tokenless]', event.event];
    for (const [key, value] of [
        ['status', event.status],
        ['provider', event.provider],
        ['action', event.action],
        ['taskId', event.taskId],
        ['browser', event.browser],
        ['url', event.providerUrl],
        ['errorCode', event.errorCode],
        ['elapsed', formatElapsed(event.elapsedMs)],
    ]) {
        if (value !== undefined && value !== null && value !== '')
            parts.push(`${key}=${formatStatusValue(value)}`);
    }
    if (event.jobId)
        parts.push(`job=${String(event.jobId).slice(0, 8)}`);
    return parts.join(' ');
}
function printPayload(payload, args) {
    if (args.json)
        console.log(JSON.stringify(payload, null, 2));
    else if (payload.compactOutput)
        console.log(payload.compactOutput);
    else
        console.log(JSON.stringify(payload, null, 2));
}
function attachStatusLog(error, statusReporter) {
    const status = statusReporter.lastStatus();
    if (status !== undefined)
        error.status = status;
    error.statusLog = statusReporter.events;
}
function usage() {
    console.error([
        'Usage:',
        '  tokenless run --provider chatgpt --project-name <agent-project> --chat-name <agent-chat> --project-root <path> --prompt-file <file> --json',
        '  tokenless run --provider chatgpt --model <visible-model> --model-fallback <model,...> --effort <instant|medium|high|extra_high|pro> --prompt <text> --json',
        '  tokenless chatgpt-controls --json',
        '  tokenless chatgpt-configure --model <visible-model> --effort <level> --json',
        '  tokenless state --task-id <task-id> --json',
        '  tokenless cancel --job-id <job-id> --json',
        '  tokenless snapshot-dom --provider chatgpt --json',
        '  tokenless config --preferred-providers chatgpt,claude,gemini --browser chrome --json',
        '  tokenless install [--extension-id <chrome-extension-id>] --json',
        '  tokenless doctor --json',
    ].join('\n'));
}
function usageError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.retryable = false;
    return error;
}
function optionalNumber(value) {
    return value === undefined ? undefined : Number(value);
}
function objectRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function formatStatusValue(value) {
    const text = String(value);
    return /\s/.test(text) ? JSON.stringify(text) : text;
}
function formatElapsed(value) {
    const milliseconds = Number(value);
    return Number.isFinite(milliseconds) ? `${Math.max(0, Math.round(milliseconds / 1000))}s` : undefined;
}
//# sourceMappingURL=tokenless.mjs.map