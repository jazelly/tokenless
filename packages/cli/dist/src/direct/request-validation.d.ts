import type { DirectProvider, DirectRunRequest } from './types.js';
export type ValidatedDirectApiRequest = Readonly<{
    model: string;
}>;
export declare function validateDirectApiRequest(request: DirectRunRequest, expectedProvider: DirectProvider, maximumTemperature?: number): ValidatedDirectApiRequest;
export declare function nonnegativeInteger(value: unknown): number | undefined;
export declare const INVALID_NONNEGATIVE_INTEGER: unique symbol;
export declare function optionalNonnegativeInteger(record: Record<string, unknown>, key: string): number | typeof INVALID_NONNEGATIVE_INTEGER | undefined;
export declare function safeNonnegativeSum(values: readonly (number | undefined)[]): number | undefined;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
//# sourceMappingURL=request-validation.d.ts.map