import { describe, expect, test } from "bun:test"
import { mergeAuthenticatedSub } from "./src/subs.ts"
import type { Provider, Sub } from "./src/types.ts"

function sub(id: string, provider: Provider, label: string, accountId?: string): Sub {
  return {
    id,
    provider,
    label,
    tokens: { access: `access-${id}`, refresh: `refresh-${id}`, expiresAt: 1, accountId },
  }
}

describe("merging authenticated subscriptions", () => {
  test("reauthenticating a Claude account replaces its credentials and preserves its ID", () => {
    const existing = sub("stable-id", "claude", "Me@Example.com")
    const authenticated = sub("new-random-id", "claude", "me@example.com")

    const result = mergeAuthenticatedSub([existing], authenticated)

    expect(result.replaced).toBe(true)
    expect(result.id).toBe("stable-id")
    expect(result.subs).toHaveLength(1)
    expect(result.subs[0]).toEqual({ ...authenticated, id: "stable-id" })
  })

  test("new accounts are appended", () => {
    const existing = sub("one", "claude", "one@example.com")
    const authenticated = sub("two", "claude", "two@example.com")

    const result = mergeAuthenticatedSub([existing], authenticated)

    expect(result.replaced).toBe(false)
    expect(result.subs).toEqual([existing, authenticated])
  })

  test("Codex accounts with different account IDs remain separate", () => {
    const existing = sub("one", "codex", "same@example.com", "account-one")
    const authenticated = sub("two", "codex", "same@example.com", "account-two")

    expect(mergeAuthenticatedSub([existing], authenticated).replaced).toBe(false)
  })

  test("accounts without a provider identity remain separate", () => {
    expect(mergeAuthenticatedSub([sub("one", "claude", "claude")], sub("two", "claude", "claude")).replaced).toBe(false)
  })
})
