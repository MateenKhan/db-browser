/**
 * The handful of Postgres type OIDs worth naming, so ad-hoc query results get
 * the same type-aware rendering as a browsed table. Anything not listed falls
 * back to `other`, which renders as plain text — a wrong *category* is a
 * cosmetic problem, never a correctness one.
 */

import { categoryForType } from '@jugaaadi/db-browser/core'
import type { ValueCategory } from '@jugaaadi/db-browser/core'

const UDT_BY_OID: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  18: 'char',
  19: 'name',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  26: 'oid',
  114: 'json',
  700: 'float4',
  701: 'float8',
  790: 'money',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1266: 'timetz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
  // arrays
  1000: '_bool',
  1005: '_int2',
  1007: '_int4',
  1009: '_text',
  1016: '_int8',
  1015: '_varchar',
  1231: '_numeric',
}

export function udtNameForOid(oid: number): string | undefined {
  return UDT_BY_OID[oid]
}

export function categoryForOid(oid: number): ValueCategory {
  const udt = UDT_BY_OID[oid]
  return udt ? categoryForType(udt) : 'other'
}
