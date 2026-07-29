/**
 * The wire protocol between the HTTP adapter (browser) and the reference
 * server (Node). Kept in the core package so both ends compile against the
 * same shapes and a mismatch is a type error rather than a runtime surprise.
 *
 * Every path is POST except the two introspection reads, so that table/column
 * names and SQL travel in a JSON body rather than a URL that ends up in access
 * logs and browser history.
 */

import type {
  BinaryCellData,
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

export const DB_BROWSER_ROUTES = {
  capabilities: '/capabilities',
  tables: '/tables',
  describe: '/describe',
  select: '/select',
  insert: '/rows/insert',
  update: '/rows/update',
  delete: '/rows/delete',
  query: '/query',
  binary: '/rows/binary',
} as const

export interface DescribeRequest {
  table: TableRef
}
export interface SelectRequest {
  query: SelectQuery
}
export interface InsertRequest {
  table: TableRef
  row: Row
}
export interface UpdateRequest {
  table: TableRef
  pk: PkValues
  patch: Row
}
export interface DeleteRequest {
  table: TableRef
  pk: PkValues
}
export interface QueryRequest {
  sql: string
  options?: Omit<RunQueryOptions, 'signal'>
}
export interface BinaryRequest {
  table: TableRef
  pk: PkValues
  column: string
}

export interface ErrorBody {
  error: {
    code: string
    message: string
    detail?: string
  }
}

export type TablesResponse = { tables: TableMeta[] }
export type DescribeResponse = { schema: TableSchema }
export type SelectResponse = { page: Page }
export type RowResponse = { row: Row }
export type QueryResponse = { result: QueryResult }
export type BinaryResponse = { data: BinaryCellData }
