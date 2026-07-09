export declare const DEFAULT_DAEMON_URL = "http://127.0.0.1:7331";
export type DaemonClientOptions = {
    daemonUrl?: string | undefined;
    homeDir?: string | undefined;
};
export type DaemonJob = {
    job_id: string;
    provider: string;
    action: string;
    status: string;
    request_json: unknown;
    result_json: unknown | null;
    error_json: unknown | null;
    created_at: string;
    updated_at: string;
};
export type DaemonClaimedJob = DaemonJob & {
    claim_token: string;
};
export type CreateDaemonJobOptions = DaemonClientOptions & {
    provider: string;
    action: string;
    requestJson?: unknown;
    jobId?: string | undefined;
    claimToken?: string | undefined;
};
export type ClaimNextDaemonJobOptions = DaemonClientOptions & {
    provider?: string | undefined;
    action?: string | undefined;
};
export type GetDaemonJobOptions = DaemonClientOptions & {
    jobId: string;
};
export type CompleteDaemonJobOptions = DaemonClientOptions & {
    jobId: string;
    claimToken: string;
    result?: unknown;
    error?: unknown;
};
export type WaitDaemonJobResultOptions = GetDaemonJobOptions & {
    timeoutMs?: number | undefined;
    pollMs?: number | undefined;
    onStatus?: ((event: Record<string, unknown>) => unknown) | undefined;
};
export declare function daemonUrl(explicitUrl?: string): string;
export declare function readDaemonToken({ homeDir }?: DaemonClientOptions): Promise<string>;
export declare function createDaemonJob({ daemonUrl: explicitDaemonUrl, provider, action, requestJson, jobId, claimToken, }: CreateDaemonJobOptions): Promise<DaemonClaimedJob>;
export declare function getDaemonJob({ daemonUrl: explicitDaemonUrl, jobId, }: GetDaemonJobOptions): Promise<DaemonJob>;
export declare function claimNextDaemonJob({ daemonUrl: explicitDaemonUrl, homeDir, provider, action, }?: ClaimNextDaemonJobOptions): Promise<{
    job: DaemonClaimedJob | null;
}>;
export declare function completeDaemonJob({ daemonUrl: explicitDaemonUrl, jobId, claimToken, result, error, }: CompleteDaemonJobOptions): Promise<DaemonJob>;
export declare function waitDaemonJobResult({ daemonUrl: explicitDaemonUrl, jobId, timeoutMs, pollMs, onStatus, }: WaitDaemonJobResultOptions): Promise<{
    ok: boolean;
    status: string;
    job: DaemonJob;
    result: unknown;
    compactOutput: string | undefined;
    error?: never;
} | {
    result?: never;
    compactOutput?: never;
    ok: boolean;
    status: string;
    job: DaemonJob;
    error: unknown;
}>;
//# sourceMappingURL=daemon-client.d.ts.map