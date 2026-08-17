import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./src/App.tsx"

const renderer = await createCliRenderer({ exitOnCtrlC: false })
createRoot(renderer).render(<App />)
