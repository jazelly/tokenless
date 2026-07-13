export declare const DIRECT_BROKER_PROTOCOL: 'tokenless.direct-broker.v1';
export declare const DEFAULT_DIRECT_BROKER_HOST = "127.0.0.1";
export declare const DEFAULT_DIRECT_BROKER_PORT = 8788;
export declare const DIRECT_BROKER_HEALTH_PATH = "/health";
export declare const DIRECT_BROKER_CAPABILITIES_PATH = "/capabilities";
export declare const DEFAULT_DIRECT_BROKER_REQUEST_BYTES: number;
export declare const MAX_DIRECT_BROKER_REQUEST_BYTES: number;
type CreateDirectBrokerOptions = Readonly<{
    serverKey: string;
    signal?: AbortSignal | undefined;
    maxRequestBytes?: number | undefined;
    maxHeaderBytes?: number | undefined;
    maxHeaderCount?: number | undefined;
    headersTimeoutMs?: number | undefined;
    requestTimeoutMs?: number | undefined;
    shutdownGraceMs?: number | undefined;
}>;
export type StartDirectBrokerOptions = CreateDirectBrokerOptions & Readonly<{
    host?: string | undefined;
    port?: number | undefined;
}>;
export type DirectBrokerHandle = Readonly<{
    host: string;
    port: number;
    url: string;
    close: () => Promise<void>;
}>;
/** Starts a broker on an explicitly loopback address (127.0.0.1 by default). */
export declare function startDirectBroker(options: StartDirectBrokerOptions): Promise<DirectBrokerHandle>;
export {};
//# sourceMappingURL=broker.d.ts.map