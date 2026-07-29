/**
 * The HTTP `DataSource` — what the browser actually uses.
 *
 * It holds no credentials and knows no connection string: the server owns the
 * connection and this adapter only ever sends table refs, bound values and
 * SQL text. That split is the security model, not a convenience.
 */

import { DbBrowserError } from '../types.js'
import type {
  BinaryCellData,
  DataSource,
  DataSourceCapabilities,
  Page,
  PkValues,
  QueryResult,
  Row,
  RunQueryOptions,
  SelectQuery,
  TableMeta,
  TableRef,
  TableSchema,
} from '../types.js'
import { DB_BROWSER_ROUTES } from './protocol.js'
import type {
  BinaryResponse,
  DescribeResponse,
  ErrorBody,
  QueryResponse,
  RowResponse,
  SelectResponse,
  TablesResponse,
} from './protocol.js'

export interface HttpDataSourceOptions {
  /** Base URL of the db-browser server, e.g. `/api/db` or `http://localhost:6960`. */
  baseUrl: string
  /** Stable id used to namespace client-side state. Defaults to `baseUrl`. */
  id?: string
  /** Extra headers (auth token, CSRF). Called per request so it can refresh. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>
  fetchImpl?: typeof fetch
  /** Overrides what the server reports. */
  capabilities?: Partial<DataSourceCapabilities>
}

export function createHttpDataSource(options: HttpDataSourceOptions): DataSource & {
  refreshCapabilities(): Promise<DataSourceCapabilities>
} {
  const base = options.baseUrl.replace(/\/+$/, '')
  const doFetch = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  if (!doFetch) throw new DbBrowserError('NO_FETCH', 'No fetch implementation available')

  let caps: DataSourceCapabilities = {
    writes: false,
    keyset: true,
    binaryFetch: false,
    ...options.capabilities,
  }

  async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const extra = options.headers ? await options.headers() : {}
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body ?? {}),
      signal,
    })
    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new DbBrowserError('BAD_RESPONSE', `Server returned non-JSON (${res.status})`)
      }
    }
    if (!res.ok) {
      const err = (parsed as ErrorBody | null)?.error
      throw new DbBrowserError(
        err?.code ?? `HTTP_${res.status}`,
        err?.message ?? `Request failed with ${res.status}`,
        err?.detail,
      )
    }
    return parsed as T
  }

  return {
    id: options.id ?? base,
    capabilities: () => caps,

    async refreshCapabilities() {
      const r = await call<{ capabilities: DataSourceCapabilities }>(DB_BROWSER_ROUTES.capabilities)
      caps = { ...caps, ...r.capabilities }
      return caps
    },

    async listTables(): Promise<TableMeta[]> {
      const r = await call<TablesResponse>(DB_BROWSER_ROUTES.tables)
      return r.tables
    },

    async describeTable(table: TableRef): Promise<TableSchema> {
      const r = await call<DescribeResponse>(DB_BROWSER_ROUTES.describe, { table })
      return r.schema
    },

    async select(query: SelectQuery): Promise<Page> {
      const r = await call<SelectResponse>(DB_BROWSER_ROUTES.select, { query })
      return r.page
    },

    async insert(table: TableRef, row: Row): Promise<Row> {
      const r = await call<RowResponse>(DB_BROWSER_ROUTES.insert, { table, row })
      return r.row
    },

    async update(table: TableRef, pk: PkValues, patch: Row): Promise<Row> {
      const r = await call<RowResponse>(DB_BROWSER_ROUTES.update, { table, pk, patch })
      return r.row
    },

    async delete(table: TableRef, pk: PkValues): Promise<void> {
      await call<unknown>(DB_BROWSER_ROUTES.delete, { table, pk })
    },

    async runQuery(sql: string, opts?: RunQueryOptions): Promise<QueryResult> {
      const { signal, ...rest } = opts ?? {}
      const r = await call<QueryResponse>(DB_BROWSER_ROUTES.query, { sql, options: rest }, signal)
      return r.result
    },

    async fetchBinary(table: TableRef, pk: PkValues, column: string): Promise<BinaryCellData> {
      const r = await call<BinaryResponse>(DB_BROWSER_ROUTES.binary, { table, pk, column })
      return r.data
    },
  }
}
