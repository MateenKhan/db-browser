/**
 * `@jugaaadi/db-browser/core` — everything that is **not** React.
 *
 * Import this entry from a Node process (an adapter, a server, a CLI) to get
 * the `DataSource` contract, the SQL guard, identifier handling, pagination
 * planning and the pending-changes model without pulling React or any DOM
 * code into the bundle.
 */

export * from './types.js'
export * from './schema.js'
export * from './sql/guard.js'
export * from './sql/identifiers.js'
export * from './sql/pagination.js'
export * from './pending/changeset.js'
export * from './render/values.js'
export * from './adapters/protocol.js'
export * from './adapters/http.js'
export * from './storage/tableStorage.js'
