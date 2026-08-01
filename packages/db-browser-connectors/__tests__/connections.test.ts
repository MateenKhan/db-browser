/**
 * The connection registry: secrets are write-only, and the loopback gate.
 *
 * These two are the security properties of the whole feature, and both are the
 * kind that a refactor breaks silently — a password leaks into a response and
 * nothing fails; a gate defaults to permissive and nothing fails. So both are
 * asserted from the outside: the store is written, read back, and the whole
 * serialised result is searched for the plaintext.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConnectionStore } from '../src/connections/store.js'
import { createSecretBox, loadSecretKey } from '../src/connections/secretbox.js'
import { assertEditable, evaluateEditGate, isLoopbackAddress } from '../src/connections/loopbackGate.js'
import { validateConnectionInput } from '../src/connections/config.js'
import { mysqlDescriptor, postgresDescriptor } from '../src/descriptors/index.js'

const dirs: string[] = []
function tempStore(): { store: ConnectionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dbb-conn-'))
  dirs.push(dir)
  return { store: new ConnectionStore({ directory: dir }), dir }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PASSWORD = 'correct-horse-battery-staple-9f2a'

function newConnection() {
  return {
    name: 'Local Postgres',
    engine: 'postgres',
    values: {
      host: 'db.internal',
      port: 5432,
      database: 'platformdb',
      user: 'browser',
      password: PASSWORD,
    },
  }
}

describe('secrets are write-only', () => {
  it('never returns the password from create', () => {
    const { store } = tempStore()
    const created = store.create(newConnection())
    expect(JSON.stringify(created)).not.toContain(PASSWORD)
    // What a form needs is *whether* it is set, and that is all it gets.
    expect(created.secretsSet).toEqual(['password'])
    expect((created.values as Record<string, unknown>).password).toBeUndefined()
  })

  it('never returns the password from list or get', () => {
    const { store } = tempStore()
    const created = store.create(newConnection())
    expect(JSON.stringify(store.list())).not.toContain(PASSWORD)
    expect(JSON.stringify(store.get(created.id))).not.toContain(PASSWORD)
  })

  it('never writes the password in plaintext to disk', () => {
    const { store, dir } = tempStore()
    store.create(newConnection())
    const onDisk = readFileSync(join(dir, 'connections.json'), 'utf8')
    expect(onDisk).not.toContain(PASSWORD)
    // It is there, encrypted, in the versioned envelope.
    expect(onDisk).toMatch(/"password":\s*"v1:/)
  })

  it('can still use the password to connect', () => {
    const { store } = tempStore()
    const created = store.create(newConnection())
    // `resolve` is the one method that decrypts, and its result never leaves
    // the process — it goes straight into a driver config.
    expect(store.resolve(created.id).secrets.password).toBe(PASSWORD)
  })

  it('keeps an existing secret when an update omits it', () => {
    // This is what makes "change the host without retyping the password" work.
    const { store } = tempStore()
    const created = store.create(newConnection())
    store.update(created.id, { name: 'Renamed', values: { host: 'other.internal' } })
    const resolved = store.resolve(created.id)
    expect(resolved.values.host).toBe('other.internal')
    expect(resolved.secrets.password).toBe(PASSWORD)
  })

  it('clears a secret only when it is explicitly emptied', () => {
    const { store } = tempStore()
    const created = store.create(newConnection())
    const updated = store.update(created.id, { values: { password: null } })
    expect(updated.secretsSet).toEqual([])
    expect(store.resolve(created.id).secrets.password).toBeUndefined()
  })

  it('refuses to change a connection’s engine', () => {
    const { store } = tempStore()
    const created = store.create(newConnection())
    expect(() => store.update(created.id, { engine: 'mysql' })).toThrow(/engine cannot be changed/i)
  })

  it('survives a round trip through a new store instance', () => {
    const { store, dir } = tempStore()
    const created = store.create(newConnection())
    const reopened = new ConnectionStore({ directory: dir })
    expect(reopened.resolve(created.id).secrets.password).toBe(PASSWORD)
    expect(JSON.stringify(reopened.list())).not.toContain(PASSWORD)
  })
})

describe('the secret box', () => {
  it('round-trips, and produces a different ciphertext each time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbb-key-'))
    dirs.push(dir)
    const box = createSecretBox(loadSecretKey(join(dir, '.key'), {}))
    const a = box.encrypt(PASSWORD)
    const b = box.encrypt(PASSWORD)
    expect(a).not.toBe(b) // a fresh IV per encryption
    expect(box.decrypt(a)).toBe(PASSWORD)
    expect(box.decrypt(b)).toBe(PASSWORD)
  })

  it('refuses a tampered ciphertext instead of decrypting it to garbage', () => {
    // This is why GCM rather than CBC: a modified ciphertext must fail loudly,
    // not decrypt to nonsense that then gets sent to a database as a password.
    const dir = mkdtempSync(join(tmpdir(), 'dbb-key-'))
    dirs.push(dir)
    const box = createSecretBox(loadSecretKey(join(dir, '.key'), {}))
    const cipher = box.encrypt(PASSWORD)
    const parts = cipher.split(':')
    const flipped = Buffer.from(parts[3], 'base64')
    flipped[0] ^= 0xff
    parts[3] = flipped.toString('base64')
    expect(() => box.decrypt(parts.join(':'))).toThrow(/could not be decrypted/i)
  })

  it('never echoes any part of the value in the failure message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbb-key-'))
    dirs.push(dir)
    const box = createSecretBox(loadSecretKey(join(dir, '.key'), {}))
    try {
      box.decrypt('v1:AAAA:BBBB:CCCC')
      throw new Error('expected a rejection')
    } catch (e) {
      expect((e as Error).message).not.toContain('CCCC')
    }
  })
})

describe('input validation is driven by the descriptor, not by engine branches', () => {
  it('rejects a missing required field, naming it', () => {
    // MySQL's `database` has no default, so omitting it is genuinely missing.
    expect(() =>
      validateConnectionInput(mysqlDescriptor, {
        name: 'x',
        values: { host: 'h', port: 3306, user: 'u' },
      }),
    ).toThrow(/"Database" is required/)
  })

  it('fills a required field that has a default rather than rejecting it', () => {
    // Postgres's `database` defaults to `postgres`. A form that omits it is
    // not incomplete — it is accepting the default, which is what a default
    // is for. Rejecting it would make the declared default unreachable.
    const out = validateConnectionInput(postgresDescriptor, {
      name: 'x',
      values: { host: 'h' },
    })
    expect(out.values.database).toBe('postgres')
    expect(out.values.port).toBe(5432)
  })

  it('drops a key the descriptor does not declare', () => {
    // The bug this prevents: a client posting `{ "sslKeyFile": "/etc/shadow" }`
    // and it being stored, then handed to a driver.
    const out = validateConnectionInput(postgresDescriptor, {
      name: 'x',
      values: { host: 'h', database: 'd', user: 'u', somethingElse: 'evil' },
    })
    expect(out.values.somethingElse).toBeUndefined()
  })

  it('coerces a form’s string port to a number', () => {
    const out = validateConnectionInput(postgresDescriptor, {
      name: 'x',
      values: { host: 'h', port: '5433', database: 'd', user: 'u' },
    })
    expect(out.values.port).toBe(5433)
  })

  it('defaults to read-only when the flag is absent', () => {
    // `!== false`, not `=== true` — a body that omits the flag entirely (an
    // older client, a hand-written curl) must get the safe answer.
    const out = validateConnectionInput(postgresDescriptor, {
      name: 'x',
      values: { host: 'h', database: 'd', user: 'u' },
    })
    expect(out.readOnly).toBe(true)
  })

  it('separates secrets from values so the serialiser cannot leak them', () => {
    const out = validateConnectionInput(postgresDescriptor, {
      name: 'x',
      values: { host: 'h', database: 'd', user: 'u', password: PASSWORD },
    })
    expect(out.secrets.password).toBe(PASSWORD)
    expect(JSON.stringify(out.values)).not.toContain(PASSWORD)
  })
})

describe('the loopback gate', () => {
  it('recognises every form of loopback', () => {
    for (const address of ['127.0.0.1', '127.0.0.2', '127.1.1.1', '::1', '::ffff:127.0.0.1', 'localhost']) {
      expect(isLoopbackAddress(address), address).toBe(true)
    }
  })

  it('does not treat “every interface” as loopback', () => {
    // `0.0.0.0` and `::` are the two that matter: they *include* loopback,
    // which is exactly why they must not pass.
    for (const address of ['0.0.0.0', '::', '10.0.0.7', '192.168.1.4', '::ffff:10.0.0.7', '128.0.0.1', '']) {
      expect(isLoopbackAddress(address), address).toBe(false)
    }
  })

  it('enables editing on a loopback binding', () => {
    const gate = evaluateEditGate({ address: '127.0.0.1', port: 6960 })
    expect(gate.editable).toBe(true)
    expect(gate.reason).toBe('loopback')
    expect(() => assertEditable(gate)).not.toThrow()
  })

  it('disables editing on 0.0.0.0 and says why', () => {
    const gate = evaluateEditGate({ address: '0.0.0.0', port: 6960 })
    expect(gate.editable).toBe(false)
    expect(gate.reason).toBe('not-loopback')
    // The refusal has to explain itself — a blank 403 on a connection form
    // reads as a bug, and the reason is the whole justification for the gate.
    expect(gate.message).toMatch(/server-side request forgery/i)
    expect(gate.message).toMatch(/credential/i)
    expect(gate.message).toContain('0.0.0.0')
    expect(gate.message).toMatch(/127\.0\.0\.1/)
    expect(() => assertEditable(gate)).toThrow(/EDITING_DISABLED|bound to/i)
  })

  it('defaults to disabled when the binding is unknown', () => {
    // Defaulting the unknown case to permissive would mean a deployment shape
    // nobody anticipated gets the dangerous behaviour.
    for (const binding of [null, undefined, {}, { address: null }] as const) {
      const gate = evaluateEditGate(binding as never)
      expect(gate.editable).toBe(false)
    }
  })

  it('can be turned off even on loopback, but never on', () => {
    expect(evaluateEditGate({ address: '127.0.0.1' }, { disabled: true }).editable).toBe(false)
    // There is deliberately no option that enables editing on a non-loopback
    // binding: the switch would be the vulnerability.
    expect(evaluateEditGate({ address: '0.0.0.0' }, { disabled: false }).editable).toBe(false)
  })
})
