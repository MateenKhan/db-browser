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
// The engine-agnostic type vocabulary and its mapping onto @jugaaadi/table's
// column-type registry. Both are pure data + pure functions: no driver, no
// React, no DOM — so a Node adapter and the browser grid read the same map.
export * from './metadata/normalizedTypes.js'
export * from './metadata/columnTypePresets.js'
export * from './sql/dialect.js'
export * from './sql/guard.js'
export * from './sql/identifiers.js'
export * from './sql/pagination.js'
export * from './pending/changeset.js'
export * from './render/values.js'
export * from './adapters/protocol.js'
export * from './adapters/http.js'
export * from './storage/tableStorage.js'
// Vector-store support: the schema contract, blob decoding, and the search /
// rebuild client. Engine-agnostic on purpose — a database is an embedding
// store because of the tables it has, so any adapter that can introspect one
// gets detection for free, and none of this imports a driver.
export * from './vector/contract.js'
export * from './vector/blob.js'
export * from './vector/service.js'
export * from './vector/jobs.js'
