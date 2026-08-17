import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import type { Sub } from "./types.ts"

const DIR = join(homedir(), ".subby")
const FILE = join(DIR, "subs.json")

export function loadSubs(): Sub[] {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")).subs
  } catch {
    return []
  }
}

export function saveSubs(subs: Sub[]): void {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify({ subs }, null, 2))
  chmodSync(FILE, 0o600)
}
