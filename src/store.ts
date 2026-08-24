import { homedir } from "node:os"
import { join } from "node:path"
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import type { Sub } from "./types.ts"

const DIR = join(homedir(), ".subby")
const FILE = join(DIR, "subs.json")

type Store = { subs: Sub[]; showEmails?: boolean }

function readStore(): Store {
  try {
    const value = JSON.parse(readFileSync(FILE, "utf8"))
    if (value && typeof value === "object" && Array.isArray(value.subs)) return value
    throw new Error(`${FILE} does not contain a valid subby store`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { subs: [] }
    throw e
  }
}

function writeStore(store: Store): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const temp = `${FILE}.${process.pid}.${crypto.randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temp, "wx", 0o600)
    writeFileSync(fd, JSON.stringify(store, null, 2))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, FILE)
    chmodSync(FILE, 0o600)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
    rmSync(temp, { force: true })
  }
}

export function loadSubs(): Sub[] {
  return readStore().subs ?? []
}

export function saveSubs(subs: Sub[]): void {
  writeStore({ ...readStore(), subs })
}

export function loadShowEmails(): boolean {
  return readStore().showEmails === true
}

export function saveShowEmails(showEmails: boolean): void {
  writeStore({ ...readStore(), showEmails })
}
