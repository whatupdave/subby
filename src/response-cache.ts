import { Database } from "bun:sqlite"
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const DEFAULT_MAX_ENTRIES = 10_000
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
const DEFAULT_PATH = join(homedir(), ".subby", "response-cache.sqlite")

interface CachedResponse {
  input: unknown[]
  output: unknown[]
  subId: string
}

interface CacheConnection {
  db: Database
  maxEntries: number
  maxBytes: number
}

interface CacheRow {
  id: string
  payload: string
  bytes: number
}

interface CacheTotals {
  entries: number
  bytes: number
}

let connection: CacheConnection | null = null

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function remove(cache: CacheConnection, id: string): void {
  cache.db.query("DELETE FROM response_cache WHERE id = ?").run(id)
}

function writeTransaction(cache: CacheConnection, write: () => void): void {
  cache.db.run("BEGIN IMMEDIATE")
  try {
    write()
    cache.db.run("COMMIT")
  } catch (error) {
    try {
      cache.db.run("ROLLBACK")
    } catch {}
    throw error
  }
}

function prune(cache: CacheConnection): void {
  const totals = cache.db.query<CacheTotals, []>(
    "SELECT count(*) AS entries, coalesce(sum(bytes), 0) AS bytes FROM response_cache",
  ).get()!
  const oldest = cache.db.query<Pick<CacheRow, "id" | "bytes">, []>(
    "SELECT id, bytes FROM response_cache ORDER BY accessed_at, id LIMIT 1",
  )
  while (totals.entries > cache.maxEntries || totals.bytes > cache.maxBytes) {
    const row = oldest.get()
    if (!row) break
    remove(cache, row.id)
    totals.entries--
    totals.bytes -= row.bytes
  }
}

function openCache(): CacheConnection {
  if (connection) return connection

  const path = process.env.SUBBY_RESPONSE_CACHE_PATH || DEFAULT_PATH
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  closeSync(openSync(path, "a", 0o600))
  chmodSync(path, 0o600)

  const db = new Database(path, { create: true, strict: true })
  try {
    db.run("PRAGMA busy_timeout = 5000")
    try {
      db.run("PRAGMA journal_mode = WAL")
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "SQLITE_BUSY") throw error
    }
    db.run(`
      CREATE TABLE IF NOT EXISTS response_cache (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS response_cache_accessed_at ON response_cache(accessed_at);
    `)
    const cache = {
      db,
      maxEntries: positiveInteger("SUBBY_RESPONSE_CACHE_MAX_ENTRIES", DEFAULT_MAX_ENTRIES),
      maxBytes: positiveInteger("SUBBY_RESPONSE_CACHE_MAX_BYTES", DEFAULT_MAX_BYTES),
    }
    writeTransaction(cache, () => prune(cache))
    connection = cache
    return cache
  } catch (error) {
    db.close(true)
    throw error
  }
}

export function cacheResponse(id: string, input: unknown[], output: unknown[], subId: string): void {
  const cache = openCache()
  const payload = JSON.stringify([input, output, subId])
  const bytes = Buffer.byteLength(payload)

  writeTransaction(cache, () => {
    if (bytes > cache.maxBytes) {
      remove(cache, id)
      return
    }
    cache.db.query(`
      INSERT INTO response_cache (id, payload, bytes, accessed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload,
        bytes = excluded.bytes,
        accessed_at = excluded.accessed_at
    `).run(id, payload, bytes, Date.now())
    prune(cache)
  })
}

export function cachedResponse(id: string): CachedResponse | null {
  const cache = openCache()
  let result: CachedResponse | null = null
  writeTransaction(cache, () => {
    const row = cache.db.query<CacheRow, [string]>(
      "SELECT id, payload, bytes FROM response_cache WHERE id = ?",
    ).get(id)
    if (!row) return

    let value: unknown
    try {
      value = JSON.parse(row.payload)
    } catch {
      remove(cache, row.id)
      return
    }
    if (!Array.isArray(value) || !Array.isArray(value[0]) || !Array.isArray(value[1]) || typeof value[2] !== "string") {
      remove(cache, row.id)
      return
    }
    cache.db.query("UPDATE response_cache SET accessed_at = ? WHERE id = ?").run(Date.now(), id)
    result = { input: value[0], output: value[1], subId: value[2] }
  })
  return result
}

export function closeResponseCache(): void {
  connection?.db.close(true)
  connection = null
}
