/** Runner recovery must conservatively preserve any externally mutating action. */
export function checkpointIndicatesExternalMutation(value: unknown) {
  if (!isPlainRecord(value)) return false
  if (value.submitted !== null && value.submitted !== undefined) return true
  const phase = isPlainRecord(value.phase) ? value.phase : null
  return phase?.state === 'started' && phase.mutating === true
}

/** V0 dispatch certainty changes only once the durable checkpoint identifies prompt submission. */
export function checkpointIndicatesPromptSubmission(value: unknown) {
  if (!isPlainRecord(value)) return false
  if (value.submitted !== null && value.submitted !== undefined) return true
  const phase = isPlainRecord(value.phase) ? value.phase : null
  return phase?.state === 'started' && phase.action === 'prompt.submit'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
}
