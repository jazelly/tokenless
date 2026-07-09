type RelayClientOptions = {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
};
type RelayRun = Record<string, unknown>;
export declare function createRelayClient({ baseUrl, fetchImpl }?: RelayClientOptions): {
    capabilities(): Promise<any>;
    createRun(run: RelayRun): Promise<any>;
};
export {};
//# sourceMappingURL=index.d.ts.map