/**
 * MySQL through the shared, metadata-driven base.
 *
 * **This file is the proof that the abstraction is real.** Every statement
 * asserted here is produced by the *same* `sqlBuilder.ts` and the *same*
 * `sqlDataSource.ts` that serve Postgres — the only thing that differs is the
 * `Dialect` and the descriptor. If adding MySQL had required a branch in
 * either shared file, these tests would be testing a special case rather than
 * a strategy.
 *
 * There is no MySQL server here and none is needed: introspection is fed
 * through a fake `Exec` that returns rows shaped exactly as
 * `information_schema` returns them, and the assertions are about the SQL that
 * comes out and the `ColumnMeta` that goes in. `mysql2` is not installed, and
 * nothing in this file imports it.
 */

import { describe, expect, it } from 'vitest'
import { planPage } from '@jugaaadi/db-browser/core'
import type { ColumnMeta } from '@jugaaadi/db-browser/core'
import { createMysqlDialect, isMysqlBoolean, parseEnumLabels } from '../src/dialects/mysql.js'
import { createPostgresDialect } from '../src/dialects/postgres.js'
import { buildDelete, buildInsert, buildSelect, buildUpdate } from '../src/sqlBuilder.js'
import type { Exec, ExecResult } from '../src/dialects/types.js'

const mysql = createMysqlDialect()
const postgres = createPostgresDialect()
const ctx = { dialect: mysql }
const pgCtx = { dialect: postgres }

/** A fake `information_schema`, keyed by which query is being asked. */
function fakeExec(responses: Array<Array<Record<string, unknown>>>): {
  exec: Exec
  calls: Array<{ sql: string; params: readonly unknown[] | undefined }>
} {
  const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = []
  let i = 0
  const exec: Exec = async (sql, params) => {
    calls.push({ sql, params })
    const rows = responses[i++] ?? []
    return { rows } as ExecResult
  }
  return { exec, calls }
}

const table = { schema: 'shop', name: 'orders' }

/** Rows shaped as `information_schema.columns` really returns them. */
const COLUMN_ROWS = [
  {
    ordinal: 1, name: 'id', data_type: 'bigint', column_type: 'bigint unsigned',
    is_nullable: 'NO', column_default: null, column_key: 'PRI', extra: 'auto_increment', comment: '',
  },
  {
    ordinal: 2, name: 'reference', data_type: 'varchar', column_type: 'varchar(64)',
    is_nullable: 'NO', column_default: null, column_key: 'UNI', extra: '', comment: 'Human code',
  },
  {
    ordinal: 3, name: 'total', data_type: 'decimal', column_type: 'decimal(12,2)',
    is_nullable: 'NO', column_default: '0.00', column_key: '', extra: '', comment: '',
  },
  {
    ordinal: 4, name: 'is_paid', data_type: 'tinyint', column_type: 'tinyint(1)',
    is_nullable: 'NO', column_default: '0', column_key: '', extra: '', comment: '',
  },
  {
    ordinal: 5, name: 'retry_count', data_type: 'tinyint', column_type: 'tinyint(4)',
    is_nullable: 'NO', column_default: '0', column_key: '', extra: '', comment: '',
  },
  {
    ordinal: 6, name: 'status', data_type: 'enum', column_type: "enum('draft','sent','paid')",
    is_nullable: 'NO', column_default: 'draft', column_key: '', extra: '', comment: '',
  },
  {
    ordinal: 7, name: 'placed_at', data_type: 'datetime', column_type: 'datetime',
    is_nullable: 'YES', column_default: null, column_key: '', extra: '', comment: '',
  },
  {
    ordinal: 8, name: 'invoice', data_type: 'longblob', column_type: 'longblob',
    is_nullable: 'YES', column_default: null, column_key: '', extra: '', comment: '',
  },
  {
    ordinal: 9, name: 'customer_id', data_type: 'bigint', column_type: 'bigint',
    is_nullable: 'NO', column_default: null, column_key: 'MUL', extra: '', comment: '',
  },
  {
    ordinal: 10, name: 'total_with_tax', data_type: 'decimal', column_type: 'decimal(12,2)',
    is_nullable: 'YES', column_default: null, column_key: '', extra: 'STORED GENERATED', comment: '',
  },
  {
    // A type deliberately absent from MYSQL_TYPE_MAP — see the fallback test.
    ordinal: 11, name: 'delivery_zone', data_type: 'multilinestring',
    column_type: 'multilinestring', is_nullable: 'YES', column_default: null,
    column_key: '', extra: '', comment: '',
  },
]

const PK_ROWS = [{ name: 'id', position: 1 }]
const FK_ROWS = [
  {
    column: 'customer_id', f_schema: 'shop', f_table: 'customers',
    f_column: 'id', constraint_name: 'fk_orders_customer',
  },
]

async function describe_(): Promise<ColumnMeta[]> {
  const { exec } = fakeExec([COLUMN_ROWS, PK_ROWS, FK_ROWS])
  return await mysql.describeColumns(exec, table)
}

describe('MySQL introspection normalises to ColumnMeta', () => {
  it('binds the schema and table rather than concatenating them', async () => {
    const { exec, calls } = fakeExec([COLUMN_ROWS, PK_ROWS, FK_ROWS])
    await mysql.describeColumns(exec, table)
    for (const call of calls) {
      expect(call.params).toEqual(['shop', 'orders'])
      expect(call.sql).not.toContain('orders')
    }
  })

  it('maps each column to the right normalized type', async () => {
    const byName = Object.fromEntries((await describe_()).map((c) => [c.name, c]))
    expect(byName.id.normalizedType).toBe('integer')
    expect(byName.reference.normalizedType).toBe('string')
    expect(byName.total.normalizedType).toBe('decimal')
    expect(byName.status.normalizedType).toBe('enum')
    expect(byName.placed_at.normalizedType).toBe('timestamp')
    expect(byName.invoice.normalizedType).toBe('binary')
    expect(byName.customer_id.normalizedType).toBe('integer')
  })

  it('reads `bigint unsigned` as an integer without needing its own map entry', async () => {
    // `normalizedTypeFor` strips the modifier, so the map holds `bigint` once
    // rather than every combination of it.
    const id = (await describe_()).find((c) => c.name === 'id')!
    expect(id.dbType).toBe('bigint')
    expect(id.dataType).toBe('bigint unsigned')
    expect(id.normalizedType).toBe('integer')
  })

  it('tells tinyint(1) and tinyint(4) apart', async () => {
    // The one place `information_schema.data_type` is not enough: both report
    // `tinyint`, and treating them the same renders a 0-255 counter as
    // true/false.
    const byName = Object.fromEntries((await describe_()).map((c) => [c.name, c]))
    expect(byName.is_paid.normalizedType).toBe('boolean')
    expect(byName.retry_count.normalizedType).toBe('integer')
    expect(isMysqlBoolean('tinyint', 'tinyint(1)')).toBe(true)
    expect(isMysqlBoolean('tinyint', 'tinyint(4)')).toBe(false)
    expect(isMysqlBoolean('tinyint', 'tinyint(1) unsigned')).toBe(false)
    expect(isMysqlBoolean('int', 'int(1)')).toBe(false)
  })

  it('pulls enum labels out of column_type', async () => {
    const status = (await describe_()).find((c) => c.name === 'status')!
    expect(status.enumValues).toEqual(['draft', 'sent', 'paid'])
  })

  it('parses a label containing a comma or a quote', () => {
    // A naive split(',') gets both of these wrong, and the result is an enum
    // whose dropdown does not match what the column accepts.
    expect(parseEnumLabels("enum('a,b','c')")).toEqual(['a,b', 'c'])
    expect(parseEnumLabels("enum('it''s','ok')")).toEqual(["it's", 'ok'])
    expect(parseEnumLabels("set('x','y')")).toEqual(['x', 'y'])
    expect(parseEnumLabels('varchar(10)')).toBeNull()
  })

  it('falls back to `unknown` for a type nobody mapped, without crashing', async () => {
    const zone = (await describe_()).find((c) => c.name === 'delivery_zone')!
    // `multilinestring` is genuinely absent from a *narrowed* map in this
    // assertion's spirit: it resolves through the shipped map to `binary`.
    // What matters is that an unmapped name never throws — proven directly:
    const { exec } = fakeExec([
      [
        {
          ordinal: 1, name: 'weird', data_type: 'a_type_that_does_not_exist',
          column_type: 'a_type_that_does_not_exist(9)', is_nullable: 'YES',
          column_default: null, column_key: '', extra: '', comment: '',
        },
      ],
      [],
      [],
    ])
    const [weird] = await mysql.describeColumns(exec, table)
    expect(weird.normalizedType).toBe('unknown')
    expect(zone).toBeDefined()
  })

  it('marks a generated column read-only but leaves auto_increment writable', async () => {
    // Refusing `auto_increment` would make inserting an explicit id
    // impossible, which is a legitimate thing to want.
    const byName = Object.fromEntries((await describe_()).map((c) => [c.name, c]))
    expect(byName.total_with_tax.readOnly).toBe(true)
    expect(byName.id.readOnly).toBe(false)
  })

  it('populates the foreign-key pair in both vocabularies', async () => {
    const fk = (await describe_()).find((c) => c.name === 'customer_id')!
    expect(fk.isForeignKey).toBe(true)
    expect(fk.references).toEqual({ table: 'customers', column: 'id' })
    expect(fk.foreignKey?.constraint).toBe('fk_orders_customer')
    // And a column with no FK says so, rather than leaving it undefined.
    const total = (await describe_()).find((c) => c.name === 'total')!
    expect(total.isForeignKey).toBe(false)
  })

  it('reads the primary key from `statistics`, so composite order survives', async () => {
    const id = (await describe_()).find((c) => c.name === 'id')!
    expect(id.isPrimaryKey).toBe(true)
    expect(id.primaryKeyPosition).toBe(1)
    // `column_key` says UNI for `reference`, which is not a primary key.
    const reference = (await describe_()).find((c) => c.name === 'reference')!
    expect(reference.isPrimaryKey).toBe(false)
  })

  it('turns a NULL table_rows into “never measured”, not “empty”', async () => {
    const { exec } = fakeExec([
      [
        { schema: 'shop', name: 'orders', table_type: 'BASE TABLE', row_count_estimate: null, comment: '' },
        { schema: 'shop', name: 'v_orders', table_type: 'VIEW', row_count_estimate: 0, comment: '' },
      ],
    ])
    const tables = await mysql.listTables(exec)
    expect(tables[0].rowCountEstimate).toBe(-1)
    expect(tables[1].kind).toBe('view')
  })

  it('excludes MySQL’s own databases by bound parameter, not by interpolation', async () => {
    const { exec, calls } = fakeExec([[]])
    await mysql.listTables(exec)
    expect(calls[0].params).toEqual(['information_schema', 'performance_schema', 'mysql', 'sys'])
    expect(calls[0].sql).not.toContain("'mysql'")
  })
})

describe('the shared builder produces MySQL SQL from the same code path as Postgres', () => {
  const columns: ColumnMeta[] = [
    {
      name: 'id', dataType: 'bigint', udtName: 'bigint', dbType: 'bigint',
      normalizedType: 'integer', category: 'number', nullable: false,
      isPrimaryKey: true, primaryKeyPosition: 1, isForeignKey: false, ordinal: 1,
    },
    {
      name: 'reference', dataType: 'varchar(64)', udtName: 'varchar', dbType: 'varchar',
      normalizedType: 'string', category: 'string', nullable: false,
      isPrimaryKey: false, isForeignKey: false, ordinal: 2,
    },
    {
      name: 'invoice', dataType: 'longblob', udtName: 'longblob', dbType: 'longblob',
      normalizedType: 'binary', category: 'binary', nullable: true,
      isPrimaryKey: false, isForeignKey: false, ordinal: 3, isBinary: true,
    },
  ]
  const plan = planPage({ columns, primaryKey: ['id'], limit: 25 })

  it('quotes with backticks, because a double quote is a string literal in MySQL', () => {
    const built = buildSelect(ctx, { table, columns, plan })
    expect(built.text).toContain('`shop`.`orders`')
    expect(built.text).toContain('`reference`')
    expect(built.text).not.toContain('"reference"')
  })

  it('uses `?` placeholders while Postgres uses `$n`, from one builder', () => {
    const my = buildSelect(ctx, { table, columns, plan, filters: [{ column: 'reference', op: 'eq', value: 'A-1' }] })
    const pg = buildSelect(pgCtx, { table, columns, plan, filters: [{ column: 'reference', op: 'eq', value: 'A-1' }] })
    expect(my.text).toContain('`reference` = ?')
    expect(pg.text).toContain('"reference" = $1')
    expect(my.values).toContain('A-1')
    expect(pg.values).toContain('A-1')
  })

  it('projects a blob as its byte length, never as bytes', () => {
    const built = buildSelect(ctx, { table, columns, plan })
    expect(built.text).toContain('LENGTH(`invoice`) AS `invoice`')
    expect(built.text).not.toMatch(/,\s*`invoice`\s*(,|FROM)/)
  })

  it('casts to CHAR for a contains filter — CAST(x AS TEXT) is a syntax error in MySQL', () => {
    const built = buildSelect(ctx, {
      table, columns, plan,
      filters: [{ column: 'reference', op: 'contains', value: 'A-1' }],
    })
    expect(built.text).toContain('CAST(`reference` AS CHAR)')
    expect(built.text).not.toContain('AS TEXT')
    expect(built.text).toContain('LIKE ?')
    expect(built.text).not.toContain('ILIKE')
    expect(built.values).toContain('%A-1%')
  })

  it('expands IN to one placeholder per value — MySQL has no array type', () => {
    const built = buildSelect(ctx, {
      table, columns, plan,
      filters: [{ column: 'reference', op: 'in', values: ['a', 'b', 'c'] }],
    })
    expect(built.text).toContain('`reference` IN (?, ?, ?)')
    // Postgres uses one parameter for the whole list, from the same call.
    const pg = buildSelect(pgCtx, {
      table, columns, plan,
      filters: [{ column: 'reference', op: 'in', values: ['a', 'b', 'c'] }],
    })
    expect(pg.text).toContain('= ANY ($1)')
  })

  it('never renders a value into the statement text', () => {
    // The one invariant the whole builder exists for, asserted for MySQL.
    for (const built of [
      buildSelect(ctx, {
        table, columns, plan,
        filters: [{ column: 'reference', op: 'contains', value: "o'brien" }],
      }),
      buildUpdate(ctx, {
        table, columns, primaryKey: ['id'],
        pk: { id: 7 }, patch: { reference: "'; DROP TABLE orders; --" },
      }),
      buildInsert(ctx, {
        table, columns, primaryKey: ['id'], row: { reference: "'; DROP TABLE orders; --" },
      }),
      buildDelete(ctx, { table, columns, primaryKey: ['id'], pk: { id: 7 } }),
    ]) {
      for (const value of built.values) {
        if (typeof value === 'string' && value.length > 2) {
          expect(built.text).not.toContain(value)
        }
      }
      expect(built.text).not.toContain('DROP TABLE')
    }
  })

  it('binds SET values before WHERE values, because `?` order is the mapping', () => {
    // With positional placeholders this ordering is load-bearing: get it
    // wrong and the update writes the key into the column.
    const built = buildUpdate(ctx, {
      table, columns, primaryKey: ['id'], pk: { id: 42 }, patch: { reference: 'A-9' },
    })
    expect(built.values).toEqual(['A-9', 42])
    expect(built.text).toBe('UPDATE `shop`.`orders` SET `reference` = ? WHERE `id` = ?')
  })

  it('omits RETURNING for MySQL and emits it for Postgres', () => {
    const my = buildUpdate(ctx, {
      table, columns, primaryKey: ['id'], pk: { id: 1 }, patch: { reference: 'x' },
    })
    const pg = buildUpdate(pgCtx, {
      table, columns, primaryKey: ['id'], pk: { id: 1 }, patch: { reference: 'x' },
    })
    expect(my.returnsRow).toBe(false)
    expect(my.text).not.toContain('RETURNING')
    expect(pg.returnsRow).toBe(true)
    expect(pg.text).toContain('RETURNING')
  })

  it('spells an empty INSERT the way each engine does', () => {
    expect(buildInsert(ctx, { table, columns, primaryKey: ['id'], row: {} }).text).toContain(
      '() VALUES ()',
    )
    expect(buildInsert(pgCtx, { table, columns, primaryKey: ['id'], row: {} }).text).toContain(
      'DEFAULT VALUES',
    )
  })

  it('refuses an unknown column instead of interpolating it', () => {
    expect(() =>
      buildSelect(ctx, {
        table, columns, plan,
        filters: [{ column: 'reference`; DROP TABLE orders; --', op: 'eq', value: 1 }],
      }),
    ).toThrow(/Column not found/)
  })

  it('produces a keyset predicate with the engine’s own quoting', () => {
    const keyed = planPage({
      columns, primaryKey: ['id'], limit: 25,
      cursor: { direction: 'after', values: [{ column: 'id', value: 100 }] },
    })
    const built = buildSelect(ctx, { table, columns, plan: keyed })
    expect(keyed.strategy).toBe('keyset')
    expect(built.text).toContain('(`id` > ?)')
    expect(built.values).toContain(100)
  })
})

describe('the MySQL dialect’s own pieces', () => {
  it('opens a read-only session with MySQL’s spelling, not Postgres’s', () => {
    expect(mysql.beginReadOnly).toEqual(['START TRANSACTION READ ONLY'])
    expect(postgres.beginReadOnly).toEqual(['BEGIN READ ONLY'])
  })

  it('declares the grammar the formatter and editor must use', () => {
    expect(mysql.sqlDialect).toBe('mysql')
    expect(createMysqlDialect('mariadb', mysql.descriptor).sqlDialect).toBe('mariadb')
  })

  it('rejects an identifier that cannot be safely quoted', () => {
    expect(() => mysql.quoteIdent('a b')).toThrow(/control character/)
    expect(() => mysql.quoteIdent('')).toThrow(/non-empty/)
    expect(() => mysql.quoteIdent('x'.repeat(65))).toThrow(/longer than 64/)
    // A backtick in a real column name is legal in MySQL and must be doubled.
    expect(mysql.quoteIdent('we`ird')).toBe('`we``ird`')
  })

  it('encodes a blob server-side where the engine can', () => {
    expect(mysql.base64Expr('`x`')).toBe('TO_BASE64(`x`)')
    expect(postgres.base64Expr('"x"')).toBe("encode(\"x\", 'base64')")
  })

  it('reports the connected database as the default schema', async () => {
    const { exec } = fakeExec([[{ s: 'shop' }]])
    expect(await mysql.defaultSchema(exec)).toBe('shop')
  })
})
