import fs from 'node:fs/promises';
import path from 'node:path';
import { tokenlessHome } from './job-store.js';
export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7331';
export function daemonUrl(explicitUrl) {
    const value = explicitUrl || process.env.TOKENLESS_DAEMON_URL || DEFAULT_DAEMON_URL;
    const normalized = value.replace(/\/+$/, '');
    validateDaemonUrl(normalized);
    return normalized;
}
export async function readDaemonToken({ homeDir = tokenlessHome() } = {}) {
    return (await fs.readFile(path.join(homeDir, 'daemon.token'), 'utf8')).trim();
}
export async function createDaemonJob({ daemonUrl: explicitDaemonUrl, provider, action, requestJson = {}, jobId, claimToken, }) {
    return daemonRequest({
        daemonUrl: explicitDaemonUrl,
        path: '/jobs',
        body: {
            provider,
            action,
            request_json: requestJson,
            job_id: jobId,
            claim_token: claimToken,
        },
    });
}
export async function claimNextDaemonJob({ daemonUrl: explicitDaemonUrl, homeDir, provider, action, } = {}) {
    const token = await readDaemonToken({ homeDir });
    const query = new URLSearchParams();
    if (provider)
        query.set('provider', provider);
    if (action)
        query.set('action', action);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return daemonRequest({
        daemonUrl: explicitDaemonUrl,
        path: `/control/jobs/claim-next${suffix}`,
        token,
    });
}
export async function completeDaemonJob({ daemonUrl: explicitDaemonUrl, jobId, claimToken, result, error, }) {
    const hasResult = result !== undefined;
    const hasError = error !== undefined;
    if (hasResult === hasError) {
        throw daemonClientError('invalid_daemon_completion', 'Pass exactly one of result or error when completing a daemon job.', false);
    }
    return daemonRequest({
        daemonUrl: explicitDaemonUrl,
        path: `/jobs/${encodeURIComponent(jobId)}/complete`,
        body: {
            claim_token: claimToken,
            result_json: hasResult ? result : undefined,
            error_json: hasError ? error : undefined,
        },
    });
}
async function daemonRequest({ daemonUrl: explicitDaemonUrl, path: requestPath, body, token, }) {
    const headers = {
        accept: 'application/json',
    };
    let payload;
    if (body) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(stripUndefined(body));
    }
    if (token) {
        headers.authorization = `Bearer ${token}`;
    }
    const requestInit = {
        method: 'POST',
        headers,
    };
    if (payload !== undefined) {
        requestInit.body = payload;
    }
    const response = await fetch(`${daemonUrl(explicitDaemonUrl)}${requestPath}`, requestInit);
    const responseBody = await readJsonResponse(response);
    if (!response.ok) {
        const message = errorMessageFromBody(responseBody) || `Tokenless daemon request failed with HTTP ${response.status}.`;
        throw daemonClientError('daemon_request_failed', message, response.status >= 500, response.status);
    }
    return responseBody;
}
async function readJsonResponse(response) {
    const text = await response.text();
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        throw daemonClientError('daemon_invalid_response', 'Tokenless daemon returned invalid JSON.', true, response.status);
    }
}
function errorMessageFromBody(body) {
    if (!body || typeof body !== 'object')
        return null;
    const error = body.error;
    if (!error || typeof error !== 'object')
        return null;
    const message = error.message;
    return typeof message === 'string' && message.trim() ? message : null;
}
function daemonClientError(code, message, retryable, status) {
    const error = new Error(message);
    error.code = code;
    error.retryable = retryable;
    if (status !== undefined)
        error.status = status;
    return error;
}
function validateDaemonUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw daemonClientError('invalid_daemon_url', 'Tokenless daemon URL must be a valid loopback HTTP URL.', false);
    }
    if (parsed.protocol !== 'http:' || !isLoopbackHostname(parsed.hostname)) {
        throw daemonClientError('invalid_daemon_url', 'Tokenless daemon URL must be a loopback HTTP URL.', false);
    }
}
function isLoopbackHostname(hostname) {
    const normalized = hostname.toLowerCase();
    return normalized === 'localhost' ||
        normalized === '[::1]' ||
        normalized === '::1' ||
        /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
function stripUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}
//# sourceMappingURL=daemon-client.js.map