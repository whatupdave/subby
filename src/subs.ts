import type { Sub } from "./types.ts"

function sameAccount(existing: Sub, incoming: Sub): boolean {
  if (existing.provider !== incoming.provider) return false

  if (existing.provider === "codex") {
    const existingAccountId = existing.tokens.accountId
    const incomingAccountId = incoming.tokens.accountId
    if (existingAccountId || incomingAccountId) return Boolean(existingAccountId && incomingAccountId && existingAccountId === incomingAccountId)
  }

  const existingLabel = existing.label.trim().toLowerCase()
  const incomingLabel = incoming.label.trim().toLowerCase()
  return existingLabel !== existing.provider && existingLabel === incomingLabel
}

export function mergeAuthenticatedSub(subs: Sub[], incoming: Sub): { subs: Sub[]; replaced: boolean; id: string } {
  const index = subs.findIndex((existing) => sameAccount(existing, incoming))
  if (index < 0) return { subs: [...subs, incoming], replaced: false, id: incoming.id }

  const id = subs[index]!.id
  const next = [...subs]
  next[index] = { ...incoming, id }
  return { subs: next, replaced: true, id }
}
