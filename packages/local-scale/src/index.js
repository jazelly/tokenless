import fs from 'node:fs/promises'
import path from 'node:path'

export {
  buildTaskUrl,
  completeLocalJob,
  createLocalJob,
  ensureJobStore,
  installNativeHost,
  JOB_STATES,
  LOCAL_JOB_PROTOCOL_VERSION,
  NATIVE_HOST_NAME,
  nativeMessagingHostDir,
  nativeMessagingHostDirs,
  readLocalJobRequest,
  tokenlessHome,
  waitLocalJobResult,
  writeJobState,
} from './job-store.js'

const DEFAULT_MAX_FILE_BYTES = 24_000
const DEFAULT_MAX_TOTAL_BYTES = 80_000

export async function buildLocalScalePrompt({
  userPrompt,
  projectRoot = process.cwd(),
  files = [],
  turnContext,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
} = {}) {
  if (typeof userPrompt !== 'string' || userPrompt.trim() === '') {
    throw new TypeError('userPrompt must be a nonempty string.')
  }

  const root = path.resolve(projectRoot)
  const selectedFiles = await collectFiles(root, files, maxFileBytes, maxTotalBytes)

  return [
    '# Tokenless Local Scale Request',
    '',
    '## User Prompt',
    userPrompt.trim(),
    '',
    '## Shareable Turn Context',
    sanitizeText(turnContext ?? 'No additional shareable turn context was provided.'),
    '',
    '## Project Root',
    root,
    '',
    '## Relevant Files',
    selectedFiles.length === 0
      ? 'No relevant files were attached.'
      : selectedFiles.map(formatFile).join('\n\n'),
  ].join('\n')
}

export async function collectFiles(projectRoot, files, maxFileBytes, maxTotalBytes) {
  const result = []
  let total = 0
  for (const file of files) {
    const absolute = path.resolve(projectRoot, file)
    if (!absolute.startsWith(`${projectRoot}${path.sep}`) && absolute !== projectRoot) {
      throw new Error(`File is outside project root: ${file}`)
    }
    const stat = await fs.stat(absolute)
    if (!stat.isFile()) continue
    const bytesToRead = Math.min(stat.size, maxFileBytes, Math.max(0, maxTotalBytes - total))
    if (bytesToRead <= 0) break
    const handle = await fs.open(absolute, 'r')
    try {
      const buffer = Buffer.alloc(bytesToRead)
      await handle.read(buffer, 0, bytesToRead, 0)
      total += bytesToRead
      result.push({
        path: path.relative(projectRoot, absolute),
        truncated: stat.size > bytesToRead,
        text: sanitizeText(buffer.toString('utf8')),
      })
    } finally {
      await handle.close()
    }
  }
  return result
}

function formatFile(file) {
  return [
    `### ${file.path}${file.truncated ? ' (truncated)' : ''}`,
    '```',
    file.text,
    '```',
  ].join('\n')
}

function sanitizeText(text) {
  return String(text)
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\n]+/gi, '$1=<redacted>')
    .trim()
}
