import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

const SECRET_PREFIX = "encv1:"

function resolveEncryptionKey() {
  const raw = String(process.env.OAUTH_APP_ENCRYPTION_KEY ?? "").trim()
  if (!raw) return null

  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex")
  }

  if (/^[A-Za-z0-9+/=_-]+$/.test(raw)) {
    try {
      const normalized = raw.replace(/-/g, "+").replace(/_/g, "/")
      const decoded = Buffer.from(normalized, "base64")
      if (decoded.length >= 32) {
        return createHash("sha256").update(decoded).digest()
      }
    } catch {
      // fall through to utf8 hash
    }
  }

  return createHash("sha256").update(raw, "utf8").digest()
}

const ENCRYPTION_KEY = resolveEncryptionKey()

export function isSecretEncryptionEnabled() {
  return Boolean(ENCRYPTION_KEY)
}

export function sealSecret(value?: string | null) {
  if (value === null || value === undefined) return null
  const input = String(value)
  if (!input || !ENCRYPTION_KEY) return input
  if (input.startsWith(SECRET_PREFIX)) return input

  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(input, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  const packed = Buffer.concat([iv, tag, ciphertext]).toString("base64url")
  return `${SECRET_PREFIX}${packed}`
}

export function openSecret(value?: string | null) {
  if (value === null || value === undefined) return null
  const input = String(value)
  if (!input || !ENCRYPTION_KEY) return input
  if (!input.startsWith(SECRET_PREFIX)) return input

  const packed = input.slice(SECRET_PREFIX.length)
  try {
    const raw = Buffer.from(packed, "base64url")
    if (raw.length <= 28) return input
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const ciphertext = raw.subarray(28)
    const decipher = createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
    return plain
  } catch {
    return input
  }
}

