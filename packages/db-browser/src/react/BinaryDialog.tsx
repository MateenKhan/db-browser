/**
 * Binary (BYTEA) inspection.
 *
 * The rule from `@jugaaadi/table`'s INTEGRATING.md, applied honestly: a
 * `blob:` URL is valid **only for the current page session**. It does not
 * survive a reload and it does not travel inside an export. So this dialog:
 *
 *  - shows metadata (size, sniffed type) that came from `octet_length`, with
 *    **no bytes fetched**;
 *  - fetches the bytes only when you ask, once, on demand;
 *  - hands them to the browser as a download and **revokes the object URL
 *    immediately** — nothing is cached, nothing is persisted, and no part of
 *    the UI ever pretends a blob URL is a durable value.
 */

import { useState } from 'react'
import { formatBytes, isBinaryPlaceholder } from '../render/values.js'
import type { ColumnMeta, DataSource, PkValues, Row, TableSchema } from '../types.js'

export interface BinaryDialogProps {
  dataSource: DataSource
  schema: TableSchema
  row: Row
  column: ColumnMeta
  onClose: () => void
}

function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

/** Enough magic numbers to label a download; never used for trust decisions. */
function sniff(base64: string): string {
  const head = atob(base64.slice(0, 16))
  const bytes = Array.from(head).map((c) => c.charCodeAt(0))
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b)
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46)) return 'image/gif'
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'application/zip'
  return 'application/octet-stream'
}

export function BinaryDialog({ dataSource, schema, row, column, onClose }: BinaryDialogProps) {
  const placeholder = row[column.name]
  const bytes = isBinaryPlaceholder(placeholder) ? placeholder.bytes : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetched, setFetched] = useState<{ type: string; size: number } | null>(null)

  const pk: PkValues = {}
  for (const name of schema.primaryKey) pk[name] = row[name]

  const download = async () => {
    if (!dataSource.fetchBinary) {
      setError('This data source cannot fetch binary cells.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const data = await dataSource.fetchBinary(schema.table, pk, column.name)
      const type = data.contentType ?? sniff(data.base64)
      const blob = base64ToBlob(data.base64, type)
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = url
        a.download = `${schema.table.name}-${column.name}`
        document.body.appendChild(a)
        a.click()
        a.remove()
      } finally {
        // Revoked at once: a blob URL is session-scoped and must never be
        // stored, shown as a value, or handed to an export.
        URL.revokeObjectURL(url)
      }
      setFetched({ type, size: blob.size })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dbb-modal-backdrop" role="dialog" aria-modal="true" aria-label="Binary cell">
      <div className="dbb-modal">
        <h3>
          {schema.table.name}.{column.name}
        </h3>
        <dl className="dbb-kv">
          <dt>Type</dt>
          <dd>{column.dataType}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(bytes)}</dd>
          <dt>Row</dt>
          <dd>
            <code>
              {Object.entries(pk)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(', ')}
            </code>
          </dd>
          {fetched ? (
            <>
              <dt>Fetched</dt>
              <dd>
                {formatBytes(fetched.size)} · {fetched.type}
              </dd>
            </>
          ) : null}
        </dl>
        <p className="dbb-muted">
          Bytes are not loaded with the page. Downloading fetches this one cell and releases the
          object URL immediately — the value is never cached and would not survive a reload.
        </p>
        {error ? <div className="dbb-banner dbb-banner-error">{error}</div> : null}
        <div className="dbb-modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button type="button" className="dbb-primary" onClick={download} disabled={busy || !bytes}>
            {busy ? 'Fetching…' : 'Fetch & download'}
          </button>
        </div>
      </div>
    </div>
  )
}
