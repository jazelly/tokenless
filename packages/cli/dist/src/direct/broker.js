import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { resolveDirectApiConfig } from './config.js';
import { ANTHROPIC_VERSION } from './protocols/anthropic-messages.js';
import { DirectError } from './types.js';
export const DIRECT_BROKER_PROTOCOL = 'tokenless.direct-broker.v1';
export const DEFAULT_DIRECT_BROKER_HOST = '127.0.0.1';
export const DEFAULT_DIRECT_BROKER_PORT = 8_788;
export const DIRECT_BROKER_HEALTH_PATH = '/health';
export const DIRECT_BROKER_CAPABILITIES_PATH = '/capabilities';
const DEFAULT_MAX_HEADER_BYTES = 32 * 1_024;
const DEFAULT_MAX_HEADER_COUNT = 100;
export const DEFAULT_DIRECT_BROKER_REQUEST_BYTES = 64 * 1_024 * 1_024;
export const MAX_DIRECT_BROKER_REQUEST_BYTES = 512 * 1_024 * 1_024;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const MIN_SERVER_KEY_CHARACTERS = 32;
const MAX_SERVER_KEY_CHARACTERS = 8_192;
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);
const SENSITIVE_REQUEST_HEADERS = new Set([
    'authorization',
    'authentication-info',
    'cookie',
    'cookie2',
    'host',
    'proxy-authentication-info',
    'proxy-authorization',
    'x-api-key',
    'x-goog-api-key',
    'x-tokenless-provider',
]);
const SAFE_REQUEST_HEADERS = new Set([
    'accept',
    'anthropic-beta',
    'anthropic-version',
    'cache-control',
    'content-encoding',
    'content-length',
    'content-type',
    'idempotency-key',
    'openai-beta',
    'x-client-request-id',
    'x-goog-api-client',
    'x-idempotency-key',
    'x-request-id',
]);
const SAFE_RESPONSE_HEADERS = new Set([
    'cache-control',
    'content-disposition',
    'content-encoding',
    'content-length',
    'content-type',
    'etag',
    'expires',
    'last-modified',
    'openai-processing-ms',
    'openai-request-id',
    'openai-version',
    'request-id',
    'retry-after',
    'x-goog-request-id',
    'x-request-id',
    'x-should-retry',
]);
const CREDENTIAL_QUERY_NAMES = new Set([
    'accesskey',
    'accesstoken',
    'apikey',
    'auth',
    'authorization',
    'bearertoken',
    'credential',
    'key',
    'password',
    'secret',
    'token',
    'xapikey',
    'xgoogapikey',
]);
const BROKER_STATES = new WeakMap();
const REQUESTS_CLOSING_AFTER_RESPONSE = new WeakSet();
/** Builds the internal server used only by the loopback-validating public starter. */
function createDirectBroker(options) {
    if (options === null || typeof options !== 'object') {
        throw configurationError('Direct broker options are required.');
    }
    if (options.signal?.aborted === true) {
        throw configurationError('The direct broker cannot start with an already-aborted signal.');
    }
    const expectedAuthorizationDigest = serverAuthorizationDigest(options.serverKey);
    const maxRequestBytes = boundedInteger(options.maxRequestBytes, DEFAULT_DIRECT_BROKER_REQUEST_BYTES, 1, MAX_DIRECT_BROKER_REQUEST_BYTES, 'request body limit');
    const maxHeaderBytes = boundedInteger(options.maxHeaderBytes, DEFAULT_MAX_HEADER_BYTES, 1_024, 128 * 1_024, 'header byte limit');
    const maxHeaderCount = boundedInteger(options.maxHeaderCount, DEFAULT_MAX_HEADER_COUNT, 1, 1_000, 'header count limit');
    const headersTimeoutMs = boundedInteger(options.headersTimeoutMs, DEFAULT_HEADERS_TIMEOUT_MS, 1, 120_000, 'headers timeout');
    const requestTimeoutMs = boundedInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1, 600_000, 'request timeout');
    const shutdownGraceMs = boundedInteger(options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS, 0, 120_000, 'shutdown grace period');
    const state = {
        closing: false,
        shutdownGraceMs,
        sockets: new Set(),
        upstreamRequests: new Set(),
    };
    const handle = (request, response, sendContinue = false) => {
        response.once('finish', () => {
            if (state.closing)
                server.closeIdleConnections();
        });
        void handleBrokerRequest({
            request,
            response,
            sendContinue,
            expectedAuthorizationDigest,
            maxHeaderCount,
            maxRequestBytes,
            state,
        });
    };
    const server = http.createServer({ maxHeaderSize: maxHeaderBytes }, (request, response) => {
        handle(request, response);
    });
    server.maxHeadersCount = maxHeaderCount;
    server.headersTimeout = headersTimeoutMs;
    server.requestTimeout = requestTimeoutMs;
    server.keepAliveTimeout = 5_000;
    server.on('checkContinue', (request, response) => {
        handle(request, response, true);
    });
    server.on('connection', (socket) => {
        state.sockets.add(socket);
        socket.once('close', () => state.sockets.delete(socket));
    });
    server.prependListener('listening', () => {
        if (state.closing)
            server.close();
    });
    server.on('clientError', (error, socket) => {
        if (!socket.writable)
            return;
        const status = error.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    BROKER_STATES.set(server, state);
    if (options.signal !== undefined) {
        const onAbort = () => {
            void closeDirectBroker(server);
        };
        if (options.signal.aborted)
            onAbort();
        else
            options.signal.addEventListener('abort', onAbort, { once: true });
        server.once('close', () => options.signal?.removeEventListener('abort', onAbort));
    }
    return server;
}
/** Starts a broker on an explicitly loopback address (127.0.0.1 by default). */
export async function startDirectBroker(options) {
    if (options === null || typeof options !== 'object') {
        throw configurationError('Direct broker options are required.');
    }
    if (options.signal?.aborted === true) {
        throw configurationError('The direct broker cannot start with an already-aborted signal.');
    }
    const host = validateLoopbackHost(options.host ?? DEFAULT_DIRECT_BROKER_HOST);
    const port = boundedInteger(options.port, DEFAULT_DIRECT_BROKER_PORT, 0, 65_535, 'listen port');
    const server = createDirectBroker(options);
    try {
        await new Promise((resolve, reject) => {
            const onError = (error) => {
                server.off('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                server.off('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen({ host, port, exclusive: true });
        });
    }
    catch (error) {
        await closeDirectBroker(server);
        throw error;
    }
    if (BROKER_STATES.get(server)?.closing === true || signalIsAborted(options.signal)) {
        if (server.listening) {
            await new Promise((resolve) => server.close(() => resolve()));
        }
        throw configurationError('The direct broker was aborted before it finished starting.');
    }
    const address = server.address();
    if (address === null || typeof address === 'string') {
        await closeDirectBroker(server);
        throw configurationError('The direct broker did not receive a TCP listen address.');
    }
    const resolvedAddress = address;
    try {
        validateLoopbackHost(resolvedAddress.address);
    }
    catch (error) {
        await closeDirectBroker(server);
        throw error;
    }
    const urlHost = resolvedAddress.family === 'IPv6' ? `[${resolvedAddress.address}]` : resolvedAddress.address;
    return Object.freeze({
        host: resolvedAddress.address,
        port: resolvedAddress.port,
        url: `http://${urlHost}:${resolvedAddress.port}`,
        close: () => closeDirectBroker(server),
    });
}
/** Stops accepting connections, lets active streams finish, then enforces a bounded shutdown. */
function closeDirectBroker(server) {
    const state = BROKER_STATES.get(server);
    if (state === undefined)
        return Promise.reject(configurationError('The server is not a Tokenless direct broker.'));
    if (state.closePromise !== undefined)
        return state.closePromise;
    state.closing = true;
    state.closePromise = new Promise((resolve, reject) => {
        if (!server.listening) {
            destroyBrokerConnections(state);
            resolve();
            return;
        }
        let settled = false;
        let forceTimer;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            if (forceTimer !== undefined)
                clearTimeout(forceTimer);
            if (error === undefined || error.code === 'ERR_SERVER_NOT_RUNNING')
                resolve();
            else
                reject(error);
        };
        forceTimer = setTimeout(() => {
            destroyBrokerConnections(state);
            server.closeAllConnections();
        }, state.shutdownGraceMs);
        forceTimer.unref();
        server.close(finish);
    });
    return state.closePromise;
}
async function handleBrokerRequest({ request, response, sendContinue, expectedAuthorizationDigest, maxHeaderCount, maxRequestBytes, state, }) {
    try {
        if (request.rawHeaders.length / 2 > maxHeaderCount) {
            rejectBrokerRequest(request, response, 431, 'direct_configuration_error', 'The request contains too many headers.');
            return;
        }
        if (!hasValidBrokerAuthorization(request, expectedAuthorizationDigest)) {
            rejectBrokerRequest(request, response, 401, 'direct_authentication_failed', 'Direct broker authentication failed.', {
                'www-authenticate': 'Bearer',
            });
            return;
        }
        if (state.closing) {
            rejectBrokerRequest(request, response, 503, 'direct_upstream_error', 'The direct broker is shutting down.');
            return;
        }
        const target = parseRequestTarget(request.url);
        if (hasCredentialQuery(target)) {
            rejectBrokerRequest(request, response, 400, 'direct_configuration_error', 'Credential query parameters are not allowed.');
            return;
        }
        if (target.pathname === DIRECT_BROKER_HEALTH_PATH || target.pathname === DIRECT_BROKER_CAPABILITIES_PATH) {
            handleBrokerMetadataRequest(request, response, target);
            return;
        }
        const route = classifyRoute(target.pathname);
        if (route === undefined) {
            rejectBrokerRequest(request, response, 404, 'direct_unsupported_provider', 'The direct broker route is not supported.');
            return;
        }
        const method = request.method ?? '';
        if (!route.methods.includes(method)) {
            rejectBrokerRequest(request, response, 405, 'direct_configuration_error', 'The HTTP method is not supported for this route.', {
                allow: route.methods.join(', '),
            });
            return;
        }
        const contentLength = requestContentLength(request);
        if (method === 'GET' && ((contentLength ?? 0) > 0 || hasTransferEncoding(request))) {
            rejectBrokerRequest(request, response, 400, 'direct_configuration_error', 'GET discovery routes do not accept request bodies.');
            return;
        }
        const provider = selectProvider(request, route);
        if (contentLength !== undefined && contentLength > maxRequestBytes) {
            rejectBrokerRequest(request, response, 413, 'direct_request_too_large', 'The direct broker request exceeded the supported size limit.');
            return;
        }
        const config = resolveDirectApiConfig({ provider, providerApiKeyOnly: true });
        const upstream = buildUpstreamUrl(config.baseUrl, route, target.search);
        if (sendContinue)
            response.writeContinue();
        await proxyToUpstream({
            request,
            response,
            route,
            provider,
            upstream,
            apiKey: config.apiKey,
            timeoutMs: config.timeoutMs,
            maxRequestBytes,
            state,
        });
    }
    catch (error) {
        if (error instanceof DirectError) {
            rejectBrokerRequest(request, response, statusForDirectError(error), error.code, error.message);
            return;
        }
        rejectBrokerRequest(request, response, 400, 'direct_configuration_error', 'The direct broker rejected the request.');
    }
}
function handleBrokerMetadataRequest(request, response, target) {
    if (target.search !== '') {
        rejectBrokerRequest(request, response, 400, 'direct_configuration_error', 'Broker metadata routes do not accept query parameters.');
        return;
    }
    if (request.method !== 'GET') {
        rejectBrokerRequest(request, response, 405, 'direct_configuration_error', 'The HTTP method is not supported for this route.', {
            allow: 'GET',
        });
        return;
    }
    const contentLength = requestContentLength(request);
    if ((contentLength ?? 0) > 0 || hasTransferEncoding(request)) {
        rejectBrokerRequest(request, response, 400, 'direct_configuration_error', 'Broker metadata routes do not accept request bodies.');
        return;
    }
    if (target.pathname === DIRECT_BROKER_HEALTH_PATH) {
        writeJson(response, 200, { protocol: DIRECT_BROKER_PROTOCOL, status: 'ok' });
    }
    else {
        writeJson(response, 200, {
            protocol: DIRECT_BROKER_PROTOCOL,
            providers: ['chatgpt', 'claude', 'gemini', 'grok', 'antigravity'],
            authentication: 'bearer',
            officialClient: false,
            streaming: true,
        });
    }
}
function proxyToUpstream({ request, response, route, provider, upstream, apiKey, timeoutMs, maxRequestBytes, state, }) {
    return new Promise((resolve) => {
        let settled = false;
        let timedOut = false;
        let requestBytes = 0;
        let upstreamResponseStarted = false;
        let pausedForBackpressure = false;
        const requestHeaders = outboundRequestHeaders(request, provider, route, apiKey);
        const requestOptions = {
            method: request.method,
            headers: requestHeaders,
            agent: false,
        };
        const upstreamRequest = upstream.protocol === 'https:'
            ? https.request(upstream, { ...requestOptions, rejectUnauthorized: true })
            : http.request(upstream, requestOptions);
        state.upstreamRequests.add(upstreamRequest);
        const timeoutTimer = setTimeout(() => {
            if (settled)
                return;
            timedOut = true;
            upstreamRequest.destroy(new Error('Tokenless direct broker upstream timeout.'));
            if (!upstreamResponseStarted) {
                rejectBrokerRequest(request, response, 504, 'direct_timeout', 'The direct API upstream timed out.');
            }
            else if (!response.writableEnded) {
                response.destroy();
            }
            settle();
        }, timeoutMs);
        timeoutTimer.unref();
        const settle = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeoutTimer);
            state.upstreamRequests.delete(upstreamRequest);
            if (pausedForBackpressure &&
                !request.destroyed &&
                !REQUESTS_CLOSING_AFTER_RESPONSE.has(request)) {
                pausedForBackpressure = false;
                request.resume();
            }
            resolve();
        };
        upstreamRequest.once('response', (upstreamResponse) => {
            upstreamResponseStarted = true;
            if (upstreamResponse.statusCode !== undefined && upstreamResponse.statusCode >= 300 && upstreamResponse.statusCode < 400) {
                upstreamResponse.destroy();
                upstreamRequest.destroy();
                rejectBrokerRequest(request, response, 502, 'direct_upstream_error', 'The direct API upstream returned a disallowed redirect.');
                settle();
                return;
            }
            const responseHeaders = safeResponseHeaders(upstreamResponse.headers, apiKey);
            if (!request.complete) {
                response.shouldKeepAlive = false;
                responseHeaders.connection = 'close';
                closeRequestAfterResponse(request, response);
            }
            response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
            response.flushHeaders();
            upstreamResponse.once('aborted', () => {
                if (!response.writableEnded)
                    response.destroy();
                settle();
            });
            upstreamResponse.once('error', () => {
                if (!response.writableEnded)
                    response.destroy();
                settle();
            });
            upstreamResponse.once('end', settle);
            upstreamResponse.once('close', settle);
            upstreamResponse.pipe(response);
        });
        upstreamRequest.once('upgrade', (upstreamResponse, socket) => {
            upstreamResponse.destroy();
            socket.destroy();
            if (settled)
                return;
            rejectBrokerRequest(request, response, 502, 'direct_upstream_error', 'The direct API upstream returned an unsupported protocol upgrade.');
            settle();
        });
        upstreamRequest.once('error', () => {
            if (settled)
                return;
            if (!upstreamResponseStarted) {
                rejectBrokerRequest(request, response, timedOut ? 504 : 502, timedOut ? 'direct_timeout' : 'direct_upstream_error', timedOut ? 'The direct API upstream timed out.' : 'The direct API upstream request failed.');
            }
            else if (!response.writableEnded) {
                response.destroy();
            }
            settle();
        });
        upstreamRequest.once('close', () => {
            state.upstreamRequests.delete(upstreamRequest);
        });
        const abortUpstream = () => {
            if (!upstreamRequest.destroyed)
                upstreamRequest.destroy();
            settle();
        };
        request.once('aborted', abortUpstream);
        response.once('close', () => {
            if (!response.writableEnded)
                abortUpstream();
        });
        request.on('data', (chunk) => {
            requestBytes += chunk.byteLength;
            if (requestBytes > maxRequestBytes) {
                request.pause();
                upstreamRequest.destroy();
                rejectBrokerRequest(request, response, 413, 'direct_request_too_large', 'The direct broker request exceeded the supported size limit.');
                settle();
                return;
            }
            if (settled || upstreamRequest.destroyed || upstreamRequest.writableEnded)
                return;
            if (!upstreamRequest.write(chunk)) {
                pausedForBackpressure = true;
                request.pause();
                upstreamRequest.once('drain', () => {
                    pausedForBackpressure = false;
                    if (!request.destroyed && !REQUESTS_CLOSING_AFTER_RESPONSE.has(request))
                        request.resume();
                });
            }
        });
        request.once('end', () => {
            if (!settled)
                upstreamRequest.end();
        });
        request.once('error', abortUpstream);
    });
}
function classifyRoute(pathname) {
    if (pathname === '/v1/messages' || pathname === '/v1/messages/count_tokens') {
        return { family: 'anthropic', methods: ['POST'], pathname };
    }
    if (pathname === '/v1/responses' ||
        pathname === '/v1/responses/compact' ||
        pathname === '/v1/chat/completions' ||
        pathname === '/v1/embeddings' ||
        pathname === '/v1/images/generations' ||
        pathname === '/v1/images/edits' ||
        pathname === '/v1/videos/generations' ||
        pathname === '/v1/videos/edits' ||
        pathname === '/v1/videos/extensions') {
        return { family: 'openai', methods: ['POST'], pathname };
    }
    if (pathname === '/v1/models' ||
        /^\/v1\/models\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pathname) ||
        /^\/v1\/videos\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pathname)) {
        return { family: 'openai', methods: ['GET'], pathname };
    }
    if (pathname === '/v1beta/models') {
        return { family: 'gemini', methods: ['GET'], pathname };
    }
    if (/^\/v1beta\/models\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pathname)) {
        return { family: 'gemini', methods: ['GET'], pathname };
    }
    if (/^\/v1beta\/models\/[A-Za-z0-9][A-Za-z0-9._-]*:(?:generateContent|streamGenerateContent)$/.test(pathname)) {
        return { family: 'gemini', methods: ['POST'], pathname };
    }
    if (pathname === '/antigravity/v1/messages' ||
        pathname === '/antigravity/v1/messages/count_tokens') {
        return { family: 'antigravity', methods: ['POST'], pathname };
    }
    if (pathname === '/antigravity/v1/models') {
        return { family: 'antigravity', methods: ['GET'], pathname };
    }
    if (pathname === '/antigravity/v1beta/models') {
        return { family: 'antigravity', methods: ['GET'], pathname };
    }
    if (/^\/antigravity\/v1beta\/models\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pathname)) {
        return { family: 'antigravity', methods: ['GET'], pathname };
    }
    if (/^\/antigravity\/v1beta\/models\/[A-Za-z0-9][A-Za-z0-9._-]*:(?:generateContent|streamGenerateContent)$/.test(pathname)) {
        return { family: 'antigravity', methods: ['POST'], pathname };
    }
    return undefined;
}
function selectProvider(request, route) {
    const selectorValues = rawHeaderValues(request, 'x-tokenless-provider');
    if (selectorValues.length > 1) {
        throw configurationError('The provider routing header must appear at most once.');
    }
    const selector = selectorValues[0];
    if (selector !== undefined) {
        if (route.family !== 'openai') {
            throw new DirectError('direct_ambiguous_model', 'The provider routing header does not match this protocol route.');
        }
        if (selector !== 'chatgpt' && selector !== 'claude' && selector !== 'grok') {
            throw new DirectError('direct_unsupported_provider', 'The provider routing header accepts only exact lowercase chatgpt, claude, or grok values.');
        }
        const modelDiscovery = route.pathname === '/v1/models' || route.pathname.startsWith('/v1/models/');
        if (selector === 'claude' && !modelDiscovery) {
            throw new DirectError('direct_ambiguous_model', 'Claude selection is supported only for model discovery routes.');
        }
        if (selector === 'grok' && route.pathname === '/v1/embeddings') {
            throw new DirectError('direct_unsupported_provider', 'The reviewed Grok gateway contract does not expose embeddings.');
        }
        if (selector === 'grok' && route.pathname === '/v1/responses/compact') {
            throw new DirectError('direct_unsupported_provider', 'The reviewed Grok gateway contract does not expose response compaction.');
        }
        if (selector !== 'grok' && route.pathname.startsWith('/v1/videos/')) {
            throw new DirectError('direct_unsupported_provider', 'The reviewed video routes require explicit Grok selection.');
        }
        return selector;
    }
    if (route.family === 'openai') {
        if (route.pathname.startsWith('/v1/videos/')) {
            throw new DirectError('direct_ambiguous_model', 'Video routes require x-tokenless-provider: grok.');
        }
        return 'chatgpt';
    }
    if (route.family === 'anthropic')
        return 'claude';
    if (route.family === 'gemini')
        return 'gemini';
    return 'antigravity';
}
function outboundRequestHeaders(request, provider, route, apiKey) {
    const connectionHeaders = new Set(String(request.headers.connection ?? '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean));
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
        const normalizedName = name.toLowerCase();
        if (value === undefined ||
            HOP_BY_HOP_HEADERS.has(normalizedName) ||
            connectionHeaders.has(normalizedName) ||
            SENSITIVE_REQUEST_HEADERS.has(normalizedName) ||
            looksLikeCredentialHeader(normalizedName) ||
            !SAFE_REQUEST_HEADERS.has(normalizedName)) {
            continue;
        }
        headers[normalizedName] = value;
    }
    headers['accept-encoding'] = 'identity';
    if (provider === 'chatgpt' || provider === 'grok') {
        headers.authorization = `Bearer ${apiKey}`;
    }
    else if (provider === 'gemini') {
        headers['x-goog-api-key'] = apiKey;
    }
    else if (provider === 'claude') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] ??= ANTHROPIC_VERSION;
    }
    else {
        headers['x-api-key'] = apiKey;
        if (route.pathname.includes('/v1/messages')) {
            headers['anthropic-version'] ??= ANTHROPIC_VERSION;
        }
    }
    return headers;
}
function safeResponseHeaders(headers, apiKey) {
    const safe = {};
    for (const [name, value] of Object.entries(headers)) {
        const normalizedName = name.toLowerCase();
        if (value === undefined || !isSafeResponseHeader(normalizedName))
            continue;
        if (headerValueContains(value, apiKey))
            continue;
        safe[normalizedName] = value;
    }
    return safe;
}
function isSafeResponseHeader(name) {
    return (SAFE_RESPONSE_HEADERS.has(name) ||
        name.startsWith('x-ratelimit-') ||
        name.startsWith('ratelimit-') ||
        name.startsWith('anthropic-ratelimit-') ||
        name.startsWith('x-goog-quota-'));
}
function buildUpstreamUrl(baseUrl, route, search) {
    const url = new URL(baseUrl);
    const basePath = url.pathname.replace(/\/+$/, '');
    if (route.family === 'antigravity') {
        const antigravityVersionRoot = /^(.*\/antigravity)\/v1(?:beta)?$/.exec(basePath)?.[1];
        const antigravityRoot = antigravityVersionRoot ??
            (basePath.endsWith('/antigravity') ? basePath : `${basePath}/antigravity`);
        if (basePath.includes('/antigravity/') && antigravityVersionRoot === undefined) {
            throw configurationError('An Antigravity direct API base URL must stop at the gateway, /antigravity, or a version root.');
        }
        url.pathname = `${antigravityRoot}${route.pathname.slice('/antigravity'.length)}`;
    }
    else {
        const version = route.pathname.startsWith('/v1beta/') || route.pathname === '/v1beta' ? 'v1beta' : 'v1';
        const suffix = route.pathname.slice(version.length + 1);
        url.pathname = basePath.endsWith(`/${version}`)
            ? `${basePath}${suffix}`
            : `${basePath}${route.pathname}`;
    }
    url.search = search;
    return url;
}
function parseRequestTarget(value) {
    if (value === undefined ||
        !value.startsWith('/') ||
        value.startsWith('//') ||
        value.includes('\\') ||
        /[\u0000-\u001f\u007f]/.test(value)) {
        throw configurationError('The direct broker request target must be an origin-form path.');
    }
    const rawPathname = value.split('?', 1)[0] ?? '';
    if (/%25/i.test(value) ||
        rawPathname.includes('..') ||
        /%(?![0-9a-f]{2})/i.test(rawPathname) ||
        /%(?:2f|5c|2e|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(rawPathname) ||
        /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPathname)) {
        throw configurationError('Encoded separators, dot segments, controls, and nested encoding are not allowed.');
    }
    try {
        return new URL(value, 'http://tokenless.invalid');
    }
    catch {
        throw configurationError('The direct broker request target is invalid.');
    }
}
function hasCredentialQuery(url) {
    for (const name of url.searchParams.keys()) {
        const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (CREDENTIAL_QUERY_NAMES.has(normalized))
            return true;
    }
    return false;
}
function requestContentLength(request) {
    const values = rawHeaderValues(request, 'content-length');
    if (values.length === 0)
        return undefined;
    if (values.length !== 1 || !/^(?:0|[1-9][0-9]*)$/.test(values[0] ?? '')) {
        throw configurationError('The request Content-Length header is invalid.');
    }
    const length = Number(values[0]);
    if (!Number.isSafeInteger(length))
        throw configurationError('The request Content-Length header is too large.');
    return length;
}
function hasTransferEncoding(request) {
    return rawHeaderValues(request, 'transfer-encoding').length > 0;
}
function hasValidBrokerAuthorization(request, expectedDigest) {
    const values = rawHeaderValues(request, 'authorization');
    if (values.length !== 1)
        return false;
    const candidateDigest = createHash('sha256').update(values[0] ?? '', 'utf8').digest();
    return timingSafeEqual(candidateDigest, expectedDigest);
}
function serverAuthorizationDigest(serverKey) {
    if (typeof serverKey !== 'string' ||
        serverKey.length < MIN_SERVER_KEY_CHARACTERS ||
        serverKey.length > MAX_SERVER_KEY_CHARACTERS ||
        !/^[\x21-\x7e]+$/.test(serverKey)) {
        throw configurationError(`The direct broker server key must contain ${MIN_SERVER_KEY_CHARACTERS} to ${MAX_SERVER_KEY_CHARACTERS} visible ASCII characters without whitespace.`);
    }
    return createHash('sha256').update(`Bearer ${serverKey}`, 'utf8').digest();
}
function rawHeaderValues(request, expectedName) {
    const values = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
        if (request.rawHeaders[index]?.toLowerCase() === expectedName) {
            const value = request.rawHeaders[index + 1];
            if (value !== undefined)
                values.push(value);
        }
    }
    return values;
}
function looksLikeCredentialHeader(name) {
    const normalized = name.replace(/[^a-z0-9]/g, '');
    return (normalized.includes('authorization') ||
        normalized.endsWith('apikey') ||
        normalized.endsWith('accesstoken') ||
        normalized.endsWith('refreshtoken') ||
        normalized.endsWith('securitytoken') ||
        normalized.endsWith('clientsecret'));
}
function headerValueContains(value, secret) {
    if (secret === '')
        return false;
    return (Array.isArray(value) ? value : [value]).some((candidate) => candidate.includes(secret));
}
function writeBrokerError(response, status, code, message, headers = {}) {
    if (response.headersSent || response.destroyed) {
        if (!response.writableEnded)
            response.destroy();
        return;
    }
    writeJson(response, status, { error: { code, message } }, headers);
}
function rejectBrokerRequest(request, response, status, code, message, headers = {}) {
    response.shouldKeepAlive = false;
    closeRequestAfterResponse(request, response);
    writeBrokerError(response, status, code, message, { ...headers, connection: 'close' });
}
function closeRequestAfterResponse(request, response) {
    if (request.destroyed || REQUESTS_CLOSING_AFTER_RESPONSE.has(request))
        return;
    REQUESTS_CLOSING_AFTER_RESPONSE.add(request);
    request.pause();
    const destroySoon = () => {
        if (!request.destroyed)
            request.socket.destroySoon();
    };
    const destroyNow = () => {
        if (!request.destroyed)
            request.destroy();
    };
    if (response.writableFinished)
        destroySoon();
    else {
        response.once('finish', destroySoon);
        response.once('close', destroyNow);
    }
}
function writeJson(response, status, body, headers = {}) {
    if (response.headersSent || response.destroyed)
        return;
    const encoded = Buffer.from(JSON.stringify(body), 'utf8');
    response.writeHead(status, {
        ...headers,
        'content-length': String(encoded.byteLength),
        'content-type': 'application/json; charset=utf-8',
    });
    response.end(encoded);
}
function statusForDirectError(error) {
    if (error.code === 'direct_configuration_error')
        return 400;
    if (error.code === 'direct_authentication_failed')
        return 502;
    if (error.code === 'direct_rate_limited')
        return 429;
    if (error.code === 'direct_request_too_large')
        return 413;
    if (error.code === 'direct_timeout')
        return 504;
    if (error.code === 'direct_unsupported_provider')
        return 400;
    if (error.code === 'direct_ambiguous_model')
        return 400;
    return 502;
}
function validateLoopbackHost(value) {
    if (typeof value !== 'string') {
        throw configurationError('The direct broker listen host must be a loopback address string.');
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'localhost' || normalized === '::1')
        return normalized;
    if (isIP(normalized) === 4 && Number(normalized.split('.')[0]) === 127)
        return normalized;
    throw configurationError('The direct broker may listen only on a loopback address.');
}
function boundedInteger(value, fallback, minimum, maximum, label) {
    const candidate = value ?? fallback;
    if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
        throw configurationError(`The direct broker ${label} must be an integer between ${minimum} and ${maximum}.`);
    }
    return candidate;
}
function signalIsAborted(signal) {
    return signal?.aborted === true;
}
function configurationError(message) {
    return new DirectError('direct_configuration_error', message);
}
function destroyBrokerConnections(state) {
    for (const request of state.upstreamRequests)
        request.destroy();
    for (const socket of state.sockets)
        socket.destroy();
    state.upstreamRequests.clear();
    state.sockets.clear();
}
//# sourceMappingURL=broker.js.map