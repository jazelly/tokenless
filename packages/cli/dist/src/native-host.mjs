#!/usr/bin/env node
import { completeLocalJob, JOB_STATES, readLocalHistory, readLocalJobRequest, readTokenlessConfig, tokenlessHome, writeDomSnapshot, writeTokenlessConfig, writeJobState, } from './job-store.js';
import { claimNextDaemonJob, completeDaemonJob, } from './daemon-client.js';
const homeDir = tokenlessHome();
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
    input = Buffer.concat([input, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    drainMessages().catch((error) => {
        writeMessage({ ok: false, error: serializeError(error) });
    });
});
process.stdin.on('end', () => process.exit(0));
async function drainMessages() {
    while (input.length >= 4) {
        const length = input.readUInt32LE(0);
        if (input.length < length + 4)
            return;
        const body = input.subarray(4, length + 4);
        input = input.subarray(length + 4);
        const message = JSON.parse(body.toString('utf8'));
        writeMessage(await handleMessage(message));
    }
}
async function handleMessage(message) {
    try {
        if (message?.type === 'tokenless.native.ping') {
            return { ok: true, result: { status: 'ready' } };
        }
        if (message?.type === 'tokenless.native.claim_job') {
            const request = await readLocalJobRequest({ homeDir, jobId: message.jobId, nonce: message.nonce });
            await writeJobState({
                homeDir,
                jobId: message.jobId,
                nonce: message.nonce,
                status: JOB_STATES.CLAIMED,
                actor: 'extension',
            });
            return { ok: true, result: { request } };
        }
        if (message?.type === 'tokenless.native.list_history') {
            const history = await readLocalHistory({
                homeDir,
                limit: message.limit,
            });
            return { ok: true, result: history };
        }
        if (message?.type === 'tokenless.native.daemon_claim_next') {
            const result = await claimNextDaemonJob({
                homeDir,
                daemonUrl: message.daemonUrl,
                provider: message.provider,
                action: message.action,
            });
            return { ok: true, result: { job: result.job } };
        }
        if (message?.type === 'tokenless.native.daemon_complete_job') {
            const job = await completeDaemonJob({
                daemonUrl: message.daemonUrl,
                jobId: message.jobId,
                claimToken: message.claimToken,
                result: Object.hasOwn(message, 'result') ? message.result : undefined,
                error: Object.hasOwn(message, 'error') ? message.error : undefined,
            });
            return { ok: true, result: job };
        }
        if (message?.type === 'tokenless.native.read_config') {
            const config = await readTokenlessConfig(homeDir);
            return { ok: true, result: config };
        }
        if (message?.type === 'tokenless.native.write_config') {
            const config = await writeTokenlessConfig({
                homeDir,
                preferredProviders: message.preferredProviders,
            });
            return { ok: true, result: config };
        }
        if (message?.type === 'tokenless.native.write_state') {
            const state = await writeJobState({
                homeDir,
                jobId: message.jobId,
                nonce: message.nonce,
                status: message.status,
                actor: 'extension',
                detail: message.detail,
            });
            return { ok: true, result: { state } };
        }
        if (message?.type === 'tokenless.native.write_result') {
            const result = await completeLocalJob({
                homeDir,
                jobId: message.jobId,
                nonce: message.nonce,
                ok: message.ok,
                result: message.result,
                error: message.error,
                actor: 'extension',
            });
            return { ok: true, result };
        }
        if (message?.type === 'tokenless.native.write_snapshot') {
            const snapshot = await writeDomSnapshot({
                homeDir,
                jobId: message.jobId,
                nonce: message.nonce,
                provider: message.provider,
                snapshot: message.snapshot,
            });
            return { ok: true, result: { snapshot } };
        }
        return {
            ok: false,
            error: {
                code: 'unsupported_native_message',
                message: 'Native host message is not supported.',
                retryable: false,
            },
        };
    }
    catch (error) {
        return { ok: false, error: serializeError(error) };
    }
}
function writeMessage(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    process.stdout.write(Buffer.concat([header, body]));
}
function serializeError(error) {
    return {
        code: error?.code || 'native_host_error',
        message: error?.message || 'Tokenless native host failed.',
        retryable: Boolean(error?.retryable),
    };
}
//# sourceMappingURL=native-host.mjs.map