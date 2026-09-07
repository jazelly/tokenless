const SEMANTIC_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function compareSemanticVersions(left: string, right: string) {
  const leftVersion = parseSemanticVersion(left)
  const rightVersion = parseSemanticVersion(right)
  if (!leftVersion || !rightVersion) return null
  for (const key of ['major', 'minor', 'patch'] as const) {
    const diff = leftVersion[key] - rightVersion[key]
    if (diff !== 0) return diff
  }
  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1
  if (leftVersion.prerelease.length > 0 && rightVersion.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length); index += 1) {
    const leftIdentifier = leftVersion.prerelease[index]
    const rightIdentifier = rightVersion.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    const diff = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier)
    if (diff !== 0) return diff
  }
  return 0
}

function parseSemanticVersion(value: string) {
  const match = SEMANTIC_VERSION_PATTERN.exec(value)
  if (!match) return null
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return {
    major,
    minor,
    patch,
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

export function isSemanticVersion(value: unknown): value is string {
  return typeof value === 'string' && parseSemanticVersion(value) !== null
}

function comparePrereleaseIdentifier(left: string, right: string) {
  const leftNumeric = /^(0|[1-9]\d*)$/.test(left)
  const rightNumeric = /^(0|[1-9]\d*)$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : (left > right ? 1 : 0)
}
