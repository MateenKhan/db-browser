/**
 * Embedding blobs: bytes in, meaning out.
 *
 * The storage contract is deliberately dumb — a `BLOB` holding a
 * **little-endian `Float32Array` of exactly `dims * 4` bytes**, L2-normalised
 * at write time. That last part is what makes similarity cheap: for unit
 * vectors, cosine similarity *is* the dot product, so nothing here has to
 * divide by a norm (and nothing has to guess whether the writer already did).
 *
 * Three things this module refuses to do, each because the alternative fails
 * silently rather than loudly:
 *
 *  1. **Guess the length.** A blob whose byte length is not a multiple of 4 is
 *     not a float array, and a blob whose float count disagrees with the row's
 *     `dims` is a corrupt or mixed-model index. Both throw.
 *  2. **Assume the host is little-endian.** `new Float32Array(buffer)` reads in
 *     *host* order. That is right on x86/ARM and wrong on a big-endian host,
 *     where every value would come back as garbage that still looks like a
 *     number. The endianness is checked once and a `DataView` path is used when
 *     it does not match.
 *  3. **Assume alignment.** `Float32Array` over an `ArrayBuffer` requires the
 *     byte offset to be a multiple of 4. A `Uint8Array` that is a *view* into a
 *     larger buffer (exactly what Node's `Buffer` is — it slices a shared pool)
 *     frequently is not, and the constructor throws. Unaligned input is copied.
 */

import { DbBrowserError } from '../types.js'

export const FLOAT32_BYTES = 4

/**
 * Whether this host stores multi-byte numbers little-endian. Computed once;
 * `true` on every platform this will realistically run on, but the fallback is
 * what makes "little-endian on the wire" an actual guarantee rather than a
 * coincidence.
 */
export const HOST_IS_LITTLE_ENDIAN: boolean = (() => {
  const probe = new Uint8Array(new Uint16Array([0x0102]).buffer)
  return probe[0] === 0x02
})()

/** Anything an adapter or `fetchBinary` might hand us for a vector cell. */
export type VectorBytes = Uint8Array | ArrayBuffer | ArrayBufferView

function toUint8(bytes: VectorBytes): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  throw new DbBrowserError('BAD_VECTOR', 'Vector value is not a byte buffer')
}

/**
 * Decode a stored embedding. `expectedDims`, when given, is checked — a vector
 * that is the wrong width for its own row is the signature of an index built
 * with one model and appended to with another, and silently returning it makes
 * every later score meaningless.
 */
export function decodeFloat32LE(bytes: VectorBytes, expectedDims?: number | null): Float32Array {
  const view = toUint8(bytes)
  if (view.byteLength === 0) {
    throw new DbBrowserError('BAD_VECTOR', 'Vector blob is empty')
  }
  if (view.byteLength % FLOAT32_BYTES !== 0) {
    throw new DbBrowserError(
      'BAD_VECTOR',
      `Vector blob is ${view.byteLength} bytes, which is not a whole number of float32s`,
    )
  }
  const count = view.byteLength / FLOAT32_BYTES
  if (expectedDims != null && count !== expectedDims) {
    throw new DbBrowserError(
      'BAD_VECTOR',
      `Vector has ${count} dimensions but the row declares ${expectedDims} — the index is inconsistent`,
    )
  }

  const aligned = view.byteOffset % FLOAT32_BYTES === 0
  if (HOST_IS_LITTLE_ENDIAN) {
    // Fast path. `slice()` copies only when the view is unaligned, which is
    // the common case for a Node `Buffer` carved out of the shared pool.
    const source = aligned ? view : view.slice()
    return new Float32Array(source.buffer, source.byteOffset, count)
  }
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = dv.getFloat32(i * FLOAT32_BYTES, true)
  return out
}

/** Encode a vector back to the stored form. Used by fixtures and tests. */
export function encodeFloat32LE(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * FLOAT32_BYTES)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < values.length; i++) dv.setFloat32(i * FLOAT32_BYTES, values[i], true)
  return out
}

/**
 * Dot product. For L2-normalised vectors this **is** cosine similarity, which
 * is why the contract normalises at write time: it moves a square root off the
 * query path and onto the build, where it runs once per chunk instead of once
 * per chunk per search.
 */
export function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new DbBrowserError(
      'DIMENSION_MISMATCH',
      `Cannot compare a ${a.length}-dimension vector with a ${b.length}-dimension one`,
    )
  }
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

export function l2Norm(v: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  return Math.sqrt(sum)
}

/** Scale to unit length. A zero vector is returned unchanged (0/0 is not 0). */
export function l2Normalize(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length)
  const norm = l2Norm(v)
  if (norm === 0) return out
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}

/**
 * True when a vector is already unit length, within float32's precision. Used
 * to *verify* an index rather than to fix one up: silently re-normalising on
 * read would hide a builder that forgot to.
 */
export function isNormalized(v: ArrayLike<number>, epsilon = 1e-3): boolean {
  return Math.abs(l2Norm(v) - 1) <= epsilon
}

/**
 * How many dimensions a blob of this size holds, or `null` when it cannot be a
 * float32 array. Cheap enough to call per cell during rendering, because it
 * only ever looks at the *length*.
 */
export function dimsForByteLength(bytes: number | null | undefined): number | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null
  if (bytes % FLOAT32_BYTES !== 0) return null
  return bytes / FLOAT32_BYTES
}
