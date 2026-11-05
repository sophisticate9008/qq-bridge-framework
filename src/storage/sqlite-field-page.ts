import type { DatabaseSync } from 'node:sqlite'
import type { DurableLookup } from '../contracts/ports.ts'
import { assert } from '../core/values.ts'

/** Read-only equality filtering; an optional existing expression index accelerates the same query. */
export function readFieldPage(database: DatabaseSync, query: DurableLookup, now: number) {
  const field = (value: string) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
  const scalar = (value: unknown) => value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)
  const limit = query.limit ?? 100
  assert(typeof query.namespace === 'string' && query.namespace.length > 0 && query.namespace.length <= 1024
    && field(query.field) && scalar(query.equals) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000
    && (query.where === undefined || field(query.where.field) && scalar(query.where.equals)),
  'STORE_INVALID_INDEX', 'Expected a bounded scalar equality query.')
  const sqlValue = (value: DurableLookup['equals']) => typeof value === 'boolean' ? Number(value) : value
  return database.prepare(`SELECT namespace, key, value, revision, updated_at AS updatedAt, expires_at AS expiresAt
    FROM durable_records WHERE namespace = ? AND json_extract(value, '$.${query.field}') IS ?
    ${query.where ? `AND json_extract(value, '$.${query.where.field}') IS ?` : ''}
    AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?`)
    .all(query.namespace, sqlValue(query.equals), ...(query.where ? [sqlValue(query.where.equals)] : []), now, limit)
}
