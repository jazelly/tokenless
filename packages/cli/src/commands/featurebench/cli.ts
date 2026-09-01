import path from 'node:path'

import { daemonUrl, issueFeatureBenchChannel } from '../../http/daemon-client.js'
import { readBootstrapDaemonUrl, tokenlessHome } from '../../bootstrap/home.js'
import { ensureDaemonReady } from '../../bootstrap/runtime.js'
import { runFeatureBenchAgent } from './agent-runtime.js'
import {
  FEATUREBENCH_BENCHMARK_COMMIT,
  FEATUREBENCH_DATASET,
  FEATUREBENCH_DATASET_REVISION,
  FEATUREBENCH_FAST_TASKS,
  FEATUREBENCH_FULL_TASKS,
  FEATUREBENCH_PROTOCOL,
  FEATUREBENCH_SCAFFOLD,
  FEATUREBENCH_WIRING_TASKS,
} from '#tokenless-server/featurebench/constants.js'

type FeatureBenchCliArgs = Record<string, unknown>

export async function featureBenchCommand(subcommand: string | undefined, args: FeatureBenchCliArgs) {
  if (subcommand === 'inspect') {
    return {
      ok: true,
      protocol: FEATUREBENCH_PROTOCOL,
      benchmark: 'FeatureBench',
      scaffold: FEATUREBENCH_SCAFFOLD,
      benchmarkCommit: FEATUREBENCH_BENCHMARK_COMMIT,
      dataset: FEATUREBENCH_DATASET,
      datasetRevision: FEATUREBENCH_DATASET_REVISION,
      attemptsPerTask: 1,
      splits: {
        fast: { tasks: FEATUREBENCH_FAST_TASKS, official: false },
        full: { tasks: FEATUREBENCH_FULL_TASKS, official: true },
      },
      wiringTasks: FEATUREBENCH_WIRING_TASKS,
    }
  }
  if (subcommand === 'issue-channel') {
    const homeDir = tokenlessHome(optionalString(args.home))
    const configuredUrl = daemonUrl(optionalString(args.daemonUrl) ?? await readBootstrapDaemonUrl(homeDir) ?? undefined)
    const daemon = await ensureDaemonReady({
      homeDir,
      daemonUrl: configuredUrl,
      timeoutMs: optionalInteger(args.daemonStartTimeoutMs, '--daemon-start-timeout-ms'),
    })
    const channel = await issueFeatureBenchChannel({
      homeDir,
      daemonUrl: daemon.url,
      instanceId: requiredString(args.instanceId, '--instance-id'),
      benchmarkRunId: requiredString(args.benchmarkRunId, '--benchmark-run-id'),
      benchmarkCommit: FEATUREBENCH_BENCHMARK_COMMIT,
      datasetRevision: FEATUREBENCH_DATASET_REVISION,
      provider: requiredString(args.provider, '--provider'),
      profile: optionalString(args.profile),
      executionMode: executionMode(args.executionMode),
      model: optionalString(args.model) ?? 'provider-default',
      effort: optionalString(args.effort),
      maxTurns: optionalInteger(args.maxSteps, '--max-steps') ?? 40,
      expiresInMs: optionalInteger(args.expiresInMs, '--expires-in-ms'),
      providerTurnTimeoutMs: optionalInteger(args.providerTurnTimeoutMs, '--provider-turn-timeout-ms'),
    })
    return { ok: true, daemonUrl: daemon.url, ...channel }
  }
  if (subcommand === 'run') {
    return await runFeatureBenchAgent({
      channelFile: path.resolve(requiredString(args.channelFile, '--channel-file')),
      instructionFile: path.resolve(requiredString(args.instructionFile, '--instruction-file')),
      workspace: path.resolve(optionalString(args.workspace) ?? '/testbed'),
      eventsFile: path.resolve(optionalString(args.eventsFile) ?? '/agent-logs/tokenless-events.jsonl'),
      maxSteps: optionalInteger(args.maxSteps, '--max-steps') ?? 40,
      toolTimeoutMs: optionalInteger(args.toolTimeoutMs, '--tool-timeout-ms') ?? 120_000,
    })
  }
  throw Object.assign(new Error('FeatureBench subcommand must be inspect, issue-channel, or run.'), { code: 'featurebench_subcommand_invalid' })
}

function requiredString(value: unknown, flag: string) {
  const normalized = optionalString(value)
  if (!normalized) throw Object.assign(new Error(`${flag} is required.`), { code: 'featurebench_option_required' })
  return normalized
}

function optionalString(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw Object.assign(new Error('FeatureBench option must be a non-empty string.'), { code: 'featurebench_option_invalid' })
  return value.trim()
}

function optionalInteger(value: unknown, flag: string) {
  if (value === undefined || value === null) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw Object.assign(new Error(`${flag} must be a positive integer.`), { code: 'featurebench_option_invalid' })
  return number
}

function executionMode(value: unknown) {
  const normalized = optionalString(value) ?? 'browser'
  if (normalized !== 'browser' && normalized !== 'direct') throw Object.assign(new Error('--execution-mode must be browser or direct.'), { code: 'featurebench_option_invalid' })
  return normalized
}
