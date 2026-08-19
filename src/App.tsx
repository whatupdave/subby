import { useEffect, useRef, useState } from "react"
import { useBlur, useFocus, useKeyboard, useRenderer } from "@opentui/react"
import { loadSubs, saveSubs } from "./store.ts"
import * as claude from "./claude.ts"
import * as codex from "./codex.ts"
import type { Provider, Sub, Usage, UsageWindow } from "./types.ts"

const providers = { claude, codex }
const PROVIDER_COLOR: Record<Provider, string> = { claude: "#d97757", codex: "#74aa9c" }
const ACCENT = "#c678dd"
const DIM = "#666666"

function bar(pct: number): string {
  const filled = Math.round(Math.max(0, Math.min(100, pct)) / 5)
  return "█".repeat(filled) + "░".repeat(20 - filled)
}

function pctColor(pct: number): string {
  return pct >= 90 ? "#ff5f5f" : pct >= 70 ? "#ffaf5f" : "#87d787"
}

function relative(ms: number): string {
  const d = ms - Date.now()
  if (d <= 0) return "now"
  const mins = Math.floor(d / 60_000)
  const h = Math.floor(mins / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`
}

function UsageRow({ name, win }: { name: string; win?: UsageWindow }) {
  if (!win) return <text fg={DIM}>  {name}  —</text>
  const pct = Math.round(win.pct)
  return (
    <text>
      <span fg={DIM}>  {name}  </span>
      <span fg={pctColor(pct)}>{bar(pct)}</span>
      <span> {String(pct).padStart(3)}%</span>
      <span fg={DIM}>{win.resetsAt ? `  resets in ${relative(win.resetsAt)}` : ""}</span>
    </text>
  )
}

function SubCard({ sub, usage, selected, onClick }: { sub: Sub; usage?: Usage; selected: boolean; onClick: () => void }) {
  return (
    <box
      border
      borderStyle="rounded"
      title={` ${sub.label} `}
      onMouseDown={onClick}
      style={{ flexDirection: "column", borderColor: selected ? ACCENT : "#3a3a3a", paddingLeft: 1, paddingRight: 1, marginBottom: 0 }}
    >
      <text fg={PROVIDER_COLOR[sub.provider]}>
        {sub.provider}
        {usage?.plan ? <span fg={DIM}> · {usage.plan}</span> : null}
      </text>
      {usage?.error ? (
        <text fg="#ff5f5f">  {usage.error}</text>
      ) : usage ? (
        <>
          <UsageRow name="session" win={usage.session} />
          <UsageRow name="weekly " win={usage.weekly} />
          {usage.scoped?.map(({ name, win }) => (
            <UsageRow key={name} name={name.padEnd(7)} win={win} />
          ))}
          {usage.stale && <text fg={DIM}>  refresh failed — showing last known</text>}
        </>
      ) : (
        <text fg={DIM}>  loading…</text>
      )}
    </box>
  )
}

type Mode = "list" | "pick" | "adding" | "confirm-remove"

export function App() {
  const renderer = useRenderer()
  const [subs, setSubs] = useState<Sub[]>(loadSubs)
  const [usages, setUsages] = useState<Record<string, Usage>>({})
  const [mode, setMode] = useState<Mode>("list")
  const [sel, setSel] = useState(0)
  const [status, setStatus] = useState("")
  const cancelLogin = useRef<(() => void) | null>(null)
  const focused = useRef(true)

  useBlur(() => {
    focused.current = false
  })
  useFocus(() => {
    focused.current = true
  })

  async function poll(list: Sub[]) {
    const entries = await Promise.all(
      list.map(async (s) => [s.id, await providers[s.provider].fetchUsage(s).catch((e) => ({ error: String(e?.message ?? e) }))] as const),
    )
    setUsages((prev) =>
      Object.fromEntries(
        entries.map(([id, usage]) => {
          const old = prev[id]
          return [id, usage.error && old && !old.error ? { ...old, stale: true } : usage]
        }),
      ),
    )
    saveSubs(list) // refresh() rotates tokens in place
  }

  useEffect(() => {
    poll(subs)
    const t = setInterval(() => {
      if (focused.current) poll(subs)
    }, 60_000)
    return () => clearInterval(t)
  }, [subs])

  function startLogin(provider: Provider) {
    let flow: ReturnType<(typeof providers)[Provider]["login"]>
    try {
      flow = providers[provider].login()
    } catch (e: any) {
      setStatus(`login failed: ${e?.message ?? e}`) // e.g. callback port in use
      setMode("list")
      return
    }
    const { promise, cancel } = flow
    cancelLogin.current = cancel
    setMode("adding")
    setStatus(`waiting for ${provider} login in browser…`)
    promise
      .then((sub) => {
        setStatus(`added ${sub.label}`)
        setSubs((prev) => {
          const next = [...prev, sub]
          saveSubs(next)
          return next
        })
        setMode("list")
      })
      .catch((e) => {
        setStatus(String(e?.message ?? e))
        setMode("list")
      })
  }

  function removeSelected() {
    const next = subs.filter((_, i) => i !== sel)
    saveSubs(next)
    setSubs(next)
    setSel((s) => Math.max(0, Math.min(s, next.length - 1)))
    setStatus("removed")
  }

  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      renderer.destroy()
      process.exit(0)
    }
    if (mode === "adding") {
      if (key.name === "escape") cancelLogin.current?.()
      return
    }
    if (mode === "pick") {
      if (key.name === "escape") setMode("list")
      return // select component handles the rest
    }
    if (mode === "confirm-remove") {
      if (key.name === "y") removeSelected()
      setMode("list")
      return
    }
    switch (key.name) {
      case "a":
        setMode("pick")
        break
      case "r":
        setStatus("refreshing…")
        poll(subs).then(() => setStatus(""))
        break
      case "d":
        if (subs.length) setMode("confirm-remove")
        break
      case "up":
      case "k":
        setSel((s) => Math.max(0, s - 1))
        break
      case "down":
      case "j":
        setSel((s) => Math.min(subs.length - 1, s + 1))
        break
    }
  })

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, padding: 1 }}>
      <text>
        <span fg={ACCENT} attributes={1}>subby</span>
        <span fg={DIM}> — claude & codex subscription usage</span>
      </text>
      <scrollbox style={{ flexGrow: 1, marginTop: 1 }}>
        {subs.map((sub, i) => (
          <SubCard key={sub.id} sub={sub} usage={usages[sub.id]} selected={i === sel && mode === "list"} onClick={() => setSel(i)} />
        ))}
        {subs.length === 0 && <text fg={DIM}>no subs yet — press [a] or click the button below</text>}
        <box
          border
          borderStyle="rounded"
          onMouseDown={() => setMode("pick")}
          style={{ borderColor: mode === "pick" ? ACCENT : "#3a3a3a", alignSelf: "flex-start", paddingLeft: 2, paddingRight: 2 }}
        >
          <text fg={ACCENT}>+ add sub</text>
        </box>
      </scrollbox>

      {mode === "pick" && (
        <box border borderStyle="rounded" title=" add sub " style={{ borderColor: ACCENT, flexDirection: "column", height: 6 }}>
          <select
            focused
            options={[
              { name: "Claude", description: "claude.ai subscription (opens browser)", value: "claude" },
              { name: "Codex", description: "chatgpt.com subscription (opens browser)", value: "codex" },
            ]}
            onSelect={(_i, opt) => opt && startLogin(opt.value as Provider)}
            style={{ flexGrow: 1 }}
          />
        </box>
      )}

      <text>
        {mode === "confirm-remove" ? (
          <span fg="#ffaf5f">remove {subs[sel]?.label}? [y/n]</span>
        ) : mode === "adding" ? (
          <span fg="#ffaf5f">{status} (esc to cancel)</span>
        ) : (
          <span fg={DIM}>[a] add · [r] refresh · [d] remove · [↑↓] select · [q] quit{status ? `  —  ${status}` : ""}</span>
        )}
      </text>
    </box>
  )
}
