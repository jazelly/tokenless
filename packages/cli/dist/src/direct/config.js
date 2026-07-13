import { isIP } from 'node:net';
import { DirectError } from './types.js';
export const DEFAULT_DIRECT_CHATGPT_BASE_URL = 'https://api.openai.com';
export const DEFAULT_DIRECT_CLAUDE_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_DIRECT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
export const DEFAULT_DIRECT_GROK_BASE_URL = 'https://api.x.ai';
export const DEFAULT_DIRECT_TIMEOUT_MS = 120_000;
export const MAX_DIRECT_TIMEOUT_MS = 600_000;
const MAX_API_KEY_CHARACTERS = 8_192;
const PROVIDER_CONFIGURATION = {
    chatgpt: {
        label: 'ChatGPT',
        baseUrlEnvironment: 'TOKENLESS_DIRECT_CHATGPT_BASE_URL',
        apiKeyEnvironment: 'TOKENLESS_DIRECT_CHATGPT_API_KEY',
        defaultBaseUrl: DEFAULT_DIRECT_CHATGPT_BASE_URL,
    },
    claude: {
        label: 'Claude',
        baseUrlEnvironment: 'TOKENLESS_DIRECT_CLAUDE_BASE_URL',
        apiKeyEnvironment: 'TOKENLESS_DIRECT_CLAUDE_API_KEY',
        defaultBaseUrl: DEFAULT_DIRECT_CLAUDE_BASE_URL,
    },
    gemini: {
        label: 'Gemini',
        baseUrlEnvironment: 'TOKENLESS_DIRECT_GEMINI_BASE_URL',
        apiKeyEnvironment: 'TOKENLESS_DIRECT_GEMINI_API_KEY',
        defaultBaseUrl: DEFAULT_DIRECT_GEMINI_BASE_URL,
    },
    grok: {
        label: 'Grok',
        baseUrlEnvironment: 'TOKENLESS_DIRECT_GROK_BASE_URL',
        apiKeyEnvironment: 'TOKENLESS_DIRECT_GROK_API_KEY',
        defaultBaseUrl: DEFAULT_DIRECT_GROK_BASE_URL,
    },
    antigravity: {
        label: 'Antigravity',
        baseUrlEnvironment: 'TOKENLESS_DIRECT_ANTIGRAVITY_BASE_URL',
        apiKeyEnvironment: 'TOKENLESS_DIRECT_ANTIGRAVITY_API_KEY',
    },
};
export function resolveDirectApiConfig(options = {}) {
    const provider = options.provider ?? 'chatgpt';
    if (!isDirectProvider(provider)) {
        throw new DirectError('direct_unsupported_provider', 'The direct API provider is not supported.');
    }
    const providerConfiguration = PROVIDER_CONFIGURATION[provider];
    const explicitBaseUrl = options.baseUrl;
    const providerBaseUrl = nonemptyEnvironmentValue(providerConfiguration.baseUrlEnvironment);
    const genericBaseUrl = nonemptyEnvironmentValue('TOKENLESS_DIRECT_BASE_URL');
    const selectedBaseUrl = explicitBaseUrl ?? providerBaseUrl ?? genericBaseUrl ?? providerConfiguration.defaultBaseUrl;
    if (selectedBaseUrl === undefined) {
        throw new DirectError('direct_configuration_error', `${providerConfiguration.label} direct API routing requires ${providerConfiguration.baseUrlEnvironment}, TOKENLESS_DIRECT_BASE_URL, or an explicit base URL.`);
    }
    const baseUrl = validateDirectBaseUrl(selectedBaseUrl);
    const apiKey = apiKeyEnvironmentValue(providerConfiguration.apiKeyEnvironment) ??
        (options.providerApiKeyOnly === true ? undefined : apiKeyEnvironmentValue('TOKENLESS_DIRECT_API_KEY'));
    if (apiKey === undefined) {
        throw new DirectError('direct_configuration_error', options.providerApiKeyOnly === true
            ? `${providerConfiguration.label} direct broker authentication requires ${providerConfiguration.apiKeyEnvironment}.`
            : `${providerConfiguration.label} direct API authentication requires ${providerConfiguration.apiKeyEnvironment} or TOKENLESS_DIRECT_API_KEY.`);
    }
    if (apiKey.length > MAX_API_KEY_CHARACTERS) {
        throw new DirectError('direct_configuration_error', `The configured ${providerConfiguration.label} direct API key is too large.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(apiKey)) {
        throw new DirectError('direct_configuration_error', 'The configured direct API key contains control characters.');
    }
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
        throw new DirectError('direct_configuration_error', 'The configured direct API key must contain visible ASCII characters only.');
    }
    const timeoutMs = resolveTimeoutMs(options.timeoutMs);
    return Object.freeze({ provider, baseUrl, apiKey, timeoutMs });
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
    if (url.search !== '' || url.hash !== '') {
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
export function responsesUrl(baseUrl) {
    return versionedEndpoint(baseUrl, 'v1', 'responses');
}
export function chatGptResponsesUrl(baseUrl) {
    return responsesUrl(baseUrl);
}
export function anthropicMessagesUrl(baseUrl) {
    return versionedEndpoint(baseUrl, 'v1', 'messages');
}
export function geminiGenerateContentUrl(baseUrl, model) {
    return versionedEndpoint(baseUrl, 'v1beta', `models/${encodedModelSegment(model)}:generateContent`);
}
export function antigravityAnthropicMessagesUrl(baseUrl) {
    return antigravityEndpoint(baseUrl, 'v1', 'messages');
}
export function antigravityGeminiGenerateContentUrl(baseUrl, model) {
    return antigravityEndpoint(baseUrl, 'v1beta', `models/${encodedModelSegment(model)}:generateContent`);
}
function versionedEndpoint(baseUrl, version, route) {
    const url = new URL(validateDirectBaseUrl(baseUrl));
    const basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = basePath.endsWith(`/${version}`)
        ? `${basePath}/${route}`
        : `${basePath}/${version}/${route}`;
    return url.toString();
}
function antigravityEndpoint(baseUrl, version, route) {
    const url = new URL(validateDirectBaseUrl(baseUrl));
    const basePath = url.pathname.replace(/\/+$/, '');
    const versionRoot = /^(.*\/antigravity)\/v1(?:beta)?$/.exec(basePath);
    if (versionRoot?.[1] !== undefined) {
        url.pathname = `${versionRoot[1]}/${version}/${route}`;
    }
    else if (basePath.endsWith('/antigravity')) {
        url.pathname = `${basePath}/${version}/${route}`;
    }
    else if (basePath.includes('/antigravity/')) {
        throw new DirectError('direct_configuration_error', 'An Antigravity direct API base URL must stop at the gateway, /antigravity, or a version root.');
    }
    else {
        url.pathname = `${basePath}/antigravity/${version}/${route}`;
    }
    return url.toString();
}
function encodedModelSegment(model) {
    if (typeof model !== 'string' || model.trim() === '' || model.includes('\0')) {
        throw new DirectError('direct_configuration_error', 'A nonempty model is required in the provider URL.');
    }
    const normalized = model.trim();
    if (normalized.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
        throw new DirectError('direct_configuration_error', 'Provider URL models must be bare identifiers containing only letters, numbers, dot, underscore, or hyphen.');
    }
    return encodeURIComponent(normalized);
}
function resolveTimeoutMs(explicitTimeoutMs) {
    const environmentTimeout = nonemptyEnvironmentValue('TOKENLESS_DIRECT_TIMEOUT_MS');
    const candidate = explicitTimeoutMs ??
        (environmentTimeout === undefined ? DEFAULT_DIRECT_TIMEOUT_MS : Number(environmentTimeout));
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
function apiKeyEnvironmentValue(name) {
    const value = process.env[name];
    if (value === undefined || value.trim() === '')
        return undefined;
    if (/[\u0000-\u001f\u007f]/.test(value)) {
        throw new DirectError('direct_configuration_error', `The configured ${name} contains control characters.`);
    }
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
function isDirectProvider(value) {
    return (value === 'chatgpt' ||
        value === 'claude' ||
        value === 'gemini' ||
        value === 'grok' ||
        value === 'antigravity');
}
//# sourceMappingURL=config.js.map