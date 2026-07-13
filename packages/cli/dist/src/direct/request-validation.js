import { DirectError } from './types.js';
const MAX_DIRECT_MODEL_CHARACTERS = 256;
export function validateDirectApiRequest(request, expectedProvider, maximumTemperature = 2) {
    if (request === null || typeof request !== 'object') {
        throw new DirectError('direct_configuration_error', 'A direct run request is required.');
    }
    if (request.provider !== expectedProvider) {
        throw new DirectError('direct_unsupported_provider', `The ${expectedProvider} API adapter only supports provider ${expectedProvider}.`);
    }
    if (request.backend !== undefined && request.backend !== 'api') {
        throw new DirectError('direct_configuration_error', 'A direct API adapter requires backend api.');
    }
    if (typeof request.model !== 'string' ||
        request.model.trim() === '' ||
        request.model.includes('\0') ||
        request.model.trim().length > MAX_DIRECT_MODEL_CHARACTERS) {
        throw new DirectError('direct_configuration_error', 'The direct API backend requires an explicit model.');
    }
    if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
        throw new DirectError('direct_configuration_error', 'A nonempty prompt is required for a direct API request.');
    }
    if (request.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)) {
        throw new DirectError('direct_configuration_error', 'maxOutputTokens must be a positive integer.');
    }
    if (request.temperature !== undefined &&
        (!Number.isFinite(request.temperature) ||
            request.temperature < 0 ||
            request.temperature > maximumTemperature)) {
        throw new DirectError('direct_configuration_error', `temperature must be a finite number between 0 and ${maximumTemperature}.`);
    }
    return { model: request.model.trim() };
}
export function nonnegativeInteger(value) {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}
export const INVALID_NONNEGATIVE_INTEGER = Symbol('invalid_nonnegative_integer');
export function optionalNonnegativeInteger(record, key) {
    const value = record[key];
    if (value === undefined || value === null)
        return undefined;
    return nonnegativeInteger(value) ?? INVALID_NONNEGATIVE_INTEGER;
}
export function safeNonnegativeSum(values) {
    const present = values.filter((value) => value !== undefined);
    if (present.length === 0)
        return undefined;
    const total = present.reduce((sum, value) => sum + value, 0);
    return Number.isSafeInteger(total) ? total : undefined;
}
export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=request-validation.js.map