export type Provider = "claude" | "codex"

export interface Sub {
  id: string
  provider: Provider
  label: string
  tokens: {
    access: string
    refresh: string
    expiresAt: number // epoch ms
    accountId?: string // codex: chatgpt account id
  }
}

export interface UsageWindow {
  pct: number
  resetsAt: number | null // epoch ms
}

export interface Usage {
  session?: UsageWindow
  weekly?: UsageWindow
  scoped?: { name: string; win: UsageWindow }[] // per-model limits, e.g. Fable weekly
  plan?: string
  error?: string
}
