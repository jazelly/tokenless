import { isIP } from 'node:net';
import { DirectError } from './types.js';
export const DEFAULT_DIRECT_CHATGPT_BASE_URL = 'https://api.openai.com';
export const DEFAULT_DIRECT_TIMEOUT_MS = 120_000;
export const MAX_DIRECT_TIMEOUT_MS = 600_000;
const MAX_API_KEY_CHARACTERS = 8_192;
export function resolveDirectApiConfig(options = {}) {
    if (options.provider !== undefined && options.provider !== 'chatgpt') {
        throw new DirectError('direct_unsupported_provider', 'The ChatGPT direct API client only supports the chatgpt provider.');
    }
    const explicitBaseUrl = options.baseUrl;
    const providerBaseUrl = nonemptyEnvironmentValue('TOKENLESS_DIRECT_CHATGPT_BASE_URL');
    const genericBaseUrl = nonemptyEnvironmentValue('TOKENLESS_DIRECT_BASE_URL');
    const baseUrl = validateDirectBaseUrl(explicitBaseUrl !== undefined
        ? explicitBaseUrl
        : providerBaseUrl ?? genericBaseUrl ?? DEFAULT_DIRECT_CHATGPT_BASE_URL);
    const apiKey = nonemptyEnvironmentValue('TOKENLESS_DIRECT_CHATGPT_API_KEY') ??
        nonemptyEnvironmentValue('TOKENLESS_DIRECT_API_KEY');
    if (apiKey === undefined) {
        throw new DirectError('direct_configuration_error', 'ChatGPT direct API authentication requires TOKENLESS_DIRECT_CHATGPT_API_KEY or TOKENLESS_DIRECT_API_KEY.');
    }
    if (apiKey.length > MAX_API_KEY_CHARACTERS) {
        throw new DirectError('direct_configuration_error', 'The configured ChatGPT direct API key is too large.');
    }
    const timeoutMs = resolveTimeoutMs(options.timeoutMs);
    return Object.freeze({ provider: 'chatgpt', baseUrl, apiKey, timeoutMs });
}
export function validateDirectBaseUrl(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new DirectError('direct_configuration_error', 'A direct API base URL must be a nonempty absolute URL.');
    }
    const candidate = value.trim();
    let url;
    try {
        url = new URL(candidate);
    }
    catch {
        throw new DirectError('direct_configuration_error', 'The direct API base URL is not a valid absolute URL.');
    }
    if (url.username !== '' || url.password !== '') {
        throw new DirectError('direct_configuration_error', 'The direct API base URL must not contain user information.');
    }
    if (candidate.includes('?') || candidate.includes('#')) {
        throw new DirectError('direct_configuration_error', 'The direct API base URL must not contain a query or fragment.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new DirectError('direct_insecure_upstream', 'Direct API upstreams must use HTTPS or loopback HTTP.');
    }
    if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
        throw new DirectError('direct_insecure_upstream', 'Plain HTTP is allowed only for a loopback direct API upstream.');
    }
    url.pathname = normalizeBasePath(url.pathname);
    return url.toString().replace(/\/$/, '');
}
export function chatGptResponsesUrl(baseUrl) {
    const url = new URL(validateDirectBaseUrl(baseUrl));
    const basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = basePath.endsWith('/v1') ? `${basePath}/responses` : `${basePath}/v1/responses`;
    return url.toString();
}
function resolveTimeoutMs(explicitTimeoutMs) {
    const environmentTimeout = nonemptyEnvironmentValue('TOKENLESS_DIRECT_TIMEOUT_MS');
    const candidate = explicitTimeoutMs ?? (environmentTimeout === undefined ? DEFAULT_DIRECT_TIMEOUT_MS : Number(environmentTimeout));
    if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > MAX_DIRECT_TIMEOUT_MS) {
        throw new DirectError('direct_configuration_error', `The direct API timeout must be an integer between 1 and ${MAX_DIRECT_TIMEOUT_MS} milliseconds.`);
    }
    return candidate;
}
function nonemptyEnvironmentValue(name) {
    const value = process.env[name];
    if (value === undefined || value.trim() === '')
        return undefined;
    return value.trim();
}
function normalizeBasePath(pathname) {
    const normalized = pathname.replace(/\/+$/, '');
    return normalized === '' ? '/' : normalized;
}
function isLoopbackHostname(hostname) {
    const unwrapped = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (unwrapped.toLowerCase() === 'localhost' || unwrapped === '::1')
        return true;
    if (isIP(unwrapped) !== 4)
        return false;
    const firstOctet = Number(unwrapped.split('.')[0]);
    return firstOctet === 127;
}
//# sourceMappingURL=config.js.map