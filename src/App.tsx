import { useEffect, useRef, useState } from "react"
import { useBlur, useFocus, useKeyboard, useRenderer } from "@opentui/react"
import { loadShowEmails, loadSubs, saveShowEmails, saveSubs } from "./store.ts"
import { mergeAuthenticatedSub } from "./subs.ts"
import * as claude from "./claude.ts"
import * as codex from "./codex.ts"
import * as proxy from "./proxy.ts"
import type { Provider, Sub, Usage, UsageWindow } from "./types.ts"

const providers = { claude, codex }
const PROVIDER_COLOR: Record<Provider, string> = { claude: "#d97757", codex: "#74aa9c" }
const ACCENT = "#c678dd"
const DIM = "#666666"

function bar(pct: number): string {
  const filled = Math.round(Math.max(0, Math.min(100, pct)) / 5)
  return "█".repeat(filled) + "░".repeat(20 - filled)
}

function streamBar(openStreams: number): string {
  const filled = Math.min(20, openStreams)
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

function ProxyDetails({ info, merged = false }: { info: proxy.ProxyInfo; merged?: boolean }) {
  const streamColor = info.rateLimited ? "#ff5f5f" : info.running ? "#87d787" : DIM

  return (
    <box style={{ flexDirection: "column", marginTop: merged ? 1 : 0 }}>
      <text>
        <span fg={DIM}>{merged ? "  proxy    " : "  status   "}</span>
        <span fg={info.running ? "#87d787" : DIM}>{info.running ? "● running" : "○ stopped"}</span>
        <span fg={DIM}>{info.running ? ` · ${info.requests} requests` : ""}</span>
      </text>
      <text><span fg={DIM}>  endpoint </span>{info.url ?? "—"}</text>
      <text>
        <span fg={DIM}>  streams  </span>
        <span fg={streamColor}>{streamBar(info.openStreams)}</span>
        <span> {info.openStreams} open</span>
        {info.rateLimited ? <span fg="#ff5f5f"> · rate limited ({info.rateLimits})</span> : null}
      </text>
      {info.lastError && info.lastError !== "upstream 429" ? <text fg="#ffaf5f">  {info.lastError}</text> : null}
    </box>
  )
}

function SubCard({ sub, usage, proxyInfo, selected, index, showEmails, onClick }: { sub: Sub; usage?: Usage; proxyInfo?: proxy.ProxyInfo; selected: boolean; index: number; showEmails: boolean; onClick: () => void }) {
  const title = showEmails ? sub.label : `[${index}]`
  const plan = showEmails ? usage?.plan : usage?.plan?.split(" · ")[0]
  return (
    <box
      border
      borderStyle="rounded"
      title={` ${proxyInfo ? "proxy · " : ""}${title} `}
      onMouseDown={onClick}
      style={{ flexDirection: "column", borderColor: proxyInfo?.rateLimited ? "#ff5f5f" : selected ? ACCENT : "#3a3a3a", paddingLeft: 1, paddingRight: 1, marginBottom: 0 }}
    >
      <text fg={PROVIDER_COLOR[sub.provider]}>
        {sub.provider}
        {plan ? <span fg={DIM}> · {plan}</span> : null}
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
      {proxyInfo ? <ProxyDetails info={proxyInfo} merged /> : null}
    </box>
  )
}

function ProxyCard({ info, subs, showEmails }: { info: proxy.ProxyInfo; subs: Sub[]; showEmails: boolean }) {
  const currentIndex = subs.findIndex((sub) => sub.id === info.currentId)
  const currentSub = currentIndex >= 0 ? subs[currentIndex] : undefined
  const currentLabel = !info.running
    ? "—"
    : !info.currentId
      ? "waiting for a request…"
      : showEmails
        ? currentSub?.label ?? "unknown"
        : currentSub
          ? `[#${currentIndex + 1}]`
          : "[unknown]"
  return (
    <box
      border
      borderStyle="rounded"
      title=" proxy "
      style={{ flexDirection: "column", borderColor: info.rateLimited ? "#ff5f5f" : "#3a3a3a", paddingLeft: 1, paddingRight: 1, marginBottom: 1 }}
    >
      <ProxyDetails info={info} />
      <text><span fg={DIM}>  sub      </span>{currentLabel}</text>
    </box>
  )
}

type Mode = "list" | "pick" | "adding" | "confirm-remove"

export function App() {
  const renderer = useRenderer()
  const [subs, setSubs] = useState<Sub[]>(loadSubs)
  const [showEmails, setShowEmails] = useState(loadShowEmails)
  const [usages, setUsages] = useState<Record<string, Usage>>({})
  const [mode, setMode] = useState<Mode>("list")
  const [sel, setSel] = useState(0)
  const [status, setStatus] = useState("")
  const [proxyInfo, setProxyInfo] = useState(proxy.info())
  const cancelLogin = useRef<(() => void) | null>(null)
  const focused = useRef(true)
  const subsRef = useRef(subs)
  const pollVersion = useRef(0)
  const proxiedSubIndex = subs.findIndex((sub) => sub.id === proxyInfo.currentId)
  // Before the first request chooses an account, keep the proxy merged into an
  // eligible Codex card rather than showing a separate waiting card.
  const proxyCardSubIndex = proxiedSubIndex >= 0
    ? proxiedSubIndex
    : subs.findIndex((sub) => sub.provider === "codex")
  const displayedSubs = proxyCardSubIndex > 0
    ? [subs[proxyCardSubIndex]!, ...subs.slice(0, proxyCardSubIndex), ...subs.slice(proxyCardSubIndex + 1)]
    : subs
  const selectedDisplayIndex = displayedSubs.findIndex((sub) => sub.id === subs[sel]?.id)

  useEffect(() => {
    proxy.setSubSource(() => subsRef.current)
    try {
      proxy.startProxy()
      setProxyInfo(proxy.info())
    } catch (e: any) {
      setStatus(`proxy failed: ${e?.message ?? e}`)
    }
    return () => {
      proxy.setSubSource(null)
      proxy.stopProxy()
    }
  }, [])
  useEffect(() => {
    subsRef.current = subs
  }, [subs])
  useEffect(() => {
    const t = setInterval(() => setProxyInfo(proxy.info()), 1_000)
    return () => clearInterval(t)
  }, [])

  function toggleProxy() {
    try {
      if (proxy.isRunning()) {
        proxy.stopProxy()
        setStatus("proxy stopped")
      } else {
        proxy.startProxy()
        setStatus("proxy started")
      }
      setProxyInfo(proxy.info())
    } catch (e: any) {
      setStatus(`proxy failed: ${e?.message ?? e}`)
    }
  }

  useBlur(() => {
    focused.current = false
  })
  useFocus(() => {
    focused.current = true
  })

  async function poll(list: Sub[]) {
    const version = ++pollVersion.current
    const entries = await Promise.all(
      list.map(async (s) => [s.id, await providers[s.provider].fetchUsage(s).catch((e) => ({ error: String(e?.message ?? e) }))] as const),
    )
    if (version !== pollVersion.current) return
    setUsages((prev) =>
      Object.fromEntries(
        entries.map(([id, usage]) => {
          const old = prev[id]
          return [id, usage.error && old && !old.error ? { ...old, stale: true } : usage]
        }),
      ),
    )
    saveSubs(subsRef.current) // refresh() rotates tokens in place
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
        const result = mergeAuthenticatedSub(subsRef.current, sub)
        pollVersion.current++
        saveSubs(result.subs)
        subsRef.current = result.subs
        if (result.replaced) proxy.credentialsUpdated(result.id)
        setSubs(result.subs)
        setStatus(result.replaced ? "reauthenticated" : "added")
        setMode("list")
      })
      .catch((e) => {
        setStatus(String(e?.message ?? e))
        setMode("list")
      })
  }

  function removeSelected() {
    const next = subs.filter((_, i) => i !== sel)
    pollVersion.current++
    saveSubs(next)
    subsRef.current = next
    setSubs(next)
    setSel((s) => Math.max(0, Math.min(s, next.length - 1)))
    setStatus("removed")
  }

  function moveSelection(offset: number) {
    if (!displayedSubs.length) return
    const current = selectedDisplayIndex >= 0 ? selectedDisplayIndex : 0
    const next = Math.max(0, Math.min(current + offset, displayedSubs.length - 1))
    const nextId = displayedSubs[next]!.id
    setSel(subs.findIndex((sub) => sub.id === nextId))
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
      case "p":
        toggleProxy()
        break
      case "e":
        setShowEmails((v) => {
          const next = !v
          saveShowEmails(next)
          return next
        })
        break
      case "up":
      case "k":
        moveSelection(-1)
        break
      case "down":
      case "j":
        moveSelection(1)
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
        {proxyCardSubIndex < 0 ? <ProxyCard info={proxyInfo} subs={subs} showEmails={showEmails} /> : null}
        {displayedSubs.map((sub, i) => {
          const subIndex = subs.findIndex((candidate) => candidate.id === sub.id)
          return (
            <SubCard
              key={sub.id}
              sub={sub}
              usage={usages[sub.id]}
              proxyInfo={subIndex === proxyCardSubIndex ? proxyInfo : undefined}
              selected={subIndex === sel && mode === "list"}
              index={i + 1}
              showEmails={showEmails}
              onClick={() => setSel(subIndex)}
            />
          )
        })}
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
          <span fg="#ffaf5f">remove {showEmails ? subs[sel]?.label : `[${selectedDisplayIndex + 1}]`}? [y/n]</span>
        ) : mode === "adding" ? (
          <span fg="#ffaf5f">{status} (esc to cancel)</span>
        ) : (
          <span fg={DIM}>
            [a] add · [r] refresh · [d] remove · [p] {proxyInfo.running ? "stop" : "start"} proxy
            {" · [e] "}
            {showEmails ? "hide" : "show"}
            {" emails · [↑↓] select · [q] quit"}
            {status ? `  —  ${status}` : ""}
          </span>
        )}
      </text>
    </box>
  )
}
