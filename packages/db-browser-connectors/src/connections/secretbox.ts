/**
 * Secret storage for the connection registry.
 *
 * AES-256-GCM with a per-install key file. This is **encryption at rest**, and
 * it is worth being precise about what it does and does not buy, because
 * overstating it is how people end up trusting it:
 *
 *  - It **does** stop a password appearing in plaintext in a file that gets
 *    backed up, synced to a cloud drive, committed by accident, or read by a
 *    process that can open the JSON but not the key (different owner, or a
 *    stray `cat connections.json` in a support ticket).
 *  - It **does not** stop anyone who can read the key file, which is anyone
 *    running as this user. That is not a gap this layer can close: the server
 *    has to be able to decrypt the password in order to connect, so the key
 *    has to be reachable by the server.
 *
 * The key file is created with mode `0600`. On Windows that flag is advisory,
 * so the honest statement is "restricted where the filesystem supports it".
 *
 * GCM, not CBC, because the authentication tag is what makes a *tampered*
 * ciphertext fail loudly instead of decrypting to garbage that then gets sent
 * to a database as a password.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { DbBrowserError } from '@jugaaadi/db-browser/core'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32
/** `v1:<iv>:<tag>:<ciphertext>`, all base64. The prefix is a format version. */
const PREFIX = 'v1'

export interface SecretBox {
  encrypt(plaintext: string): string
  decrypt(ciphertext: string): string
}

/**
 * Load, or create, the key at `keyPath`.
 *
 * `AGENTS_SECRET_KEY`-style env override is deliberately supported: a
 * containerised deployment wants the key injected, not written to a volume,
 * and a test wants a fixed key so it never touches the real one.
 */
export function loadSecretKey(keyPath: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const fromEnv = env.DB_BROWSER_SECRET_KEY
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'base64')
    if (key.length !== KEY_BYTES) {
      throw new DbBrowserError(
        'BAD_SECRET_KEY',
        `DB_BROWSER_SECRET_KEY must be ${KEY_BYTES} bytes of base64 (got ${key.length}).`,
      )
    }
    return key
  }

  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64')
    if (key.length === KEY_BYTES) return key
    throw new DbBrowserError(
      'BAD_SECRET_KEY',
      `The key file at ${keyPath} is not a ${KEY_BYTES}-byte base64 key. ` +
        'Delete it to generate a new one — every stored secret will need re-entering.',
    )
  }

  const key = randomBytes(KEY_BYTES)
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, key.toString('base64'), { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(keyPath, 0o600)
  } catch {
    // Windows. The mode is advisory there; the file is still created.
  }
  return key
}

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== KEY_BYTES) {
    throw new DbBrowserError('BAD_SECRET_KEY', `Key must be ${KEY_BYTES} bytes`)
  }
  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, key, iv)
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(
        ':',
      )
    },
    decrypt(value: string): string {
      const parts = String(value ?? '').split(':')
      if (parts.length !== 4 || parts[0] !== PREFIX) {
        throw new DbBrowserError('BAD_SECRET', 'Stored secret is not in the expected format')
      }
      const [, ivB64, tagB64, dataB64] = parts
      try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'))
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
        return Buffer.concat([
          decipher.update(Buffer.from(dataB64, 'base64')),
          decipher.final(),
        ]).toString('utf8')
      } catch {
        // Either the key changed or the file was edited. Both mean the same
        // thing to the user, and neither should echo any part of the value.
        throw new DbBrowserError(
          'SECRET_UNREADABLE',
          'A stored secret could not be decrypted — the key file has changed, or the ' +
            'connection store was edited by hand. Re-enter the password for this connection.',
        )
      }
    },
  }
}
