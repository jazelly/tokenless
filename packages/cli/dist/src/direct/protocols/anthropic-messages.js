import { invalidResponseError } from '../api-transport.js';
import { INVALID_NONNEGATIVE_INTEGER, isRecord, optionalNonnegativeInteger, safeNonnegativeSum, } from '../request-validation.js';
export const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS = 4_096;
export const ANTHROPIC_VERSION = '2023-06-01';
export function anthropicMessagesBody(request, model) {
    return {
        model,
        max_tokens: request.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: request.prompt }],
        stream: false,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    };
}
export function extractAnthropicMessageText(raw, requestId) {
    if (!Array.isArray(raw.content)) {
        throw invalidResponseError('The Anthropic Messages response did not contain assistant text.', requestId);
    }
    const blocks = [];
    for (const content of raw.content) {
        if (isRecord(content) && content.type === 'text' && typeof content.text === 'string') {
            blocks.push(content.text);
        }
    }
    if (blocks.length === 0) {
        throw invalidResponseError('The Anthropic Messages response did not contain assistant text.', requestId);
    }
    return blocks.join('\n');
}
export function normalizeAnthropicUsage(value) {
    if (!isRecord(value))
        return undefined;
    const ordinaryInputTokens = optionalNonnegativeInteger(value, 'input_tokens');
    const cacheCreationInputTokens = optionalNonnegativeInteger(value, 'cache_creation_input_tokens');
    const cacheReadInputTokens = optionalNonnegativeInteger(value, 'cache_read_input_tokens');
    const rawOutputTokens = optionalNonnegativeInteger(value, 'output_tokens');
    const invalidInput = ordinaryInputTokens === undefined ||
        ordinaryInputTokens === INVALID_NONNEGATIVE_INTEGER ||
        cacheCreationInputTokens === INVALID_NONNEGATIVE_INTEGER ||
        cacheReadInputTokens === INVALID_NONNEGATIVE_INTEGER;
    const inputTokens = invalidInput
        ? undefined
        : safeNonnegativeSum([ordinaryInputTokens, cacheCreationInputTokens, cacheReadInputTokens]);
    const outputTokens = rawOutputTokens === INVALID_NONNEGATIVE_INTEGER ? undefined : rawOutputTokens;
    const totalTokens = inputTokens === undefined || outputTokens === undefined
        ? undefined
        : safeNonnegativeSum([inputTokens, outputTokens]);
    if (inputTokens === undefined && outputTokens === undefined)
        return undefined;
    return {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(totalTokens === undefined ? {} : { totalTokens }),
    };
}
//# sourceMappingURL=anthropic-messages.js.map