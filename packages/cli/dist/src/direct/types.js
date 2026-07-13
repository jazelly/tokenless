export const DIRECT_PROTOCOL = 'tokenless.direct.v1';
const MAX_DIRECT_ERROR_MESSAGE_CHARACTERS = 512;
export class DirectError extends Error {
    code;
    retryable;
    status;
    requestId;
    constructor(code, message, options = {}) {
        super(boundErrorMessage(message));
        this.name = 'DirectError';
        this.code = code;
        this.retryable = options.retryable ?? false;
        if (options.status !== undefined)
            this.status = options.status;
        if (options.requestId !== undefined)
            this.requestId = options.requestId;
    }
    toJSON() {
        return {
            name: 'DirectError',
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...(this.status === undefined ? {} : { status: this.status }),
            ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
        };
    }
}
function boundErrorMessage(message) {
    const normalized = String(message).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (normalized || 'Direct request failed.').slice(0, MAX_DIRECT_ERROR_MESSAGE_CHARACTERS);
}
//# sourceMappingURL=types.js.map