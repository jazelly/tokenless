import { createHmac } from 'node:crypto'

import { DAEMON_PROTOCOL } from '../generated/protocol-constants.js'

export const READY_CHALLENGE_BYTES = 32
export const READY_CHALLENGE_BASE64URL_CHARS = 43

export function isCanonicalReadyChallenge(challenge: string) {
  if (challenge.length !== READY_CHALLENGE_BASE64URL_CHARS) return false
  let decoded: Buffer
  try {
    decoded = Buffer.from(challenge, 'base64url')
  } catch {
    return false
  }
  return decoded.length === READY_CHALLENGE_BYTES && decoded.toString('base64url') === challenge
}

export function daemonReadyProof(token: string, challenge: string, canonicalHome: string) {
  return createHmac('sha256', token)
    .update(daemonReadyProofMessage(challenge, canonicalHome))
    .digest('base64url')
}

export function daemonReadyProofMessage(challenge: string, canonicalHome: string) {
  return lengthPrefixedMessage([
    DAEMON_PROTOCOL,
    challenge,
    canonicalHome,
  ])
}

function lengthPrefixedMessage(fields: string[]) {
  return Buffer.concat(fields.flatMap((field) => {
    const value = Buffer.from(field, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(value.length)
    return [length, value]
  }))
}
