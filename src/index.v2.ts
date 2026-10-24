// openslimedit v2 — port of the v1 plugin (src/index.ts) to the OpenCode 2.x plugin API.
// Default entry stays src/index.ts (v1); reference this entry on 2.x hosts (export "./v2").
// Verified on OpenCode 2.0.16 and 2.0.27. On pre-2.0 hosts the guards skip registration (no crash).
//
// 2026-10-13: result compaction added — a v2-format-aware port of v1's
// "tool.execute.after" (v1 markers like "Edit applied successfully.", <path>/<type>
// tags and EOF footers never appear in 2.0.x results, so the v1 regexes were dead):
//   - edit: single-line "Edited <path> (N replacement)" -> "OK"
//   - read: "Read file <abs>, lines X-Y" header -> relative path, only for paths
//     under the session directory ("../.." chains stay absolute)
//   2.0.x carries the model-visible text in result.content[0].text (result.output
//   is a structured object); ctx.tool.hook("execute.after") has existed since 2.0.12.
// 2026-10-13: description slimming now covers v2-native `shell` + `webfetch`
// (v1's bash/fetch entries were dead — v2.0.x has no tools by those names;
// apply_patch and list likewise). Dead v1 names removed. `websearch` is
// intentionally unslimmed (no v1 counterpart).

import * as fs from "fs"
import * as path from "path"

const LINE_RANGE_RE = /^(\d+)(?:\s*-\s*(\d+))?$/

const SLIM_DESC: Record<string, string> = {
  read: "Read file content.",
  edit: "Edit file. oldString can be line range '55-64'.",
  write: "Write file.",
  shell: "Run shell command.",
  glob: "Find files.",
  grep: "Search in files.",
  webfetch: "Fetch URL.",
}

export const OpenSlimeditV2Plugin = {
  id: "openslimedit-v2",
  setup: async (ctx: any) => {
    // Kill switch (bench support): OPENSLIMEDIT_DISABLED=1 disables the whole plugin (token-baseline runs).
    if (process.env.OPENSLIMEDIT_DISABLED === "1") return;

    const directory = ctx?.location?.directory || process.cwd()

    function resolvePath(filePath: string): string {
      if (path.isAbsolute(filePath)) return path.normalize(filePath)
      return path.resolve(directory, filePath)
    }

    // 1. Slim tool descriptions (v2 context-event tools are {description, input}).
    if (ctx?.session && typeof ctx.session.hook === "function") {
      await ctx.session.hook("context", async (event: any) => {
        const tools = event?.tools
        if (!tools || typeof tools !== "object") return
        for (const name of Object.keys(tools)) {
          if (SLIM_DESC[name] && tools[name].description) {
            tools[name].description = SLIM_DESC[name]
          }
        }
      })
    }

    if (ctx?.tool && typeof ctx.tool.hook === "function") {
      // 2. Line-range edit: rewrite oldString "55-64" -> real text before edit runs.
      //    No-op when the literal text already exists (v1 semantics).
      await ctx.tool.hook("execute.before", async (a: any) => {
        if (a.tool !== "edit") return
        const oldString = a.input?.oldString
        const file = a.input?.path ?? a.input?.filePath // v2: path; v1: filePath
        if (typeof oldString !== "string" || !oldString.trim() || typeof file !== "string") return
        try {
          const content = fs.readFileSync(resolvePath(file), "utf-8")
          if (content.includes(oldString)) return
          const match = oldString.trim().match(LINE_RANGE_RE)
          if (!match) return
          const lines = content.split("\n")
          const startLine = parseInt(match[1], 10)
          const endLine = match[2] ? parseInt(match[2], 10) : startLine
          if (startLine >= 1 && startLine <= endLine && endLine <= lines.length) {
            a.input = { ...a.input, oldString: lines.slice(startLine - 1, endLine).join("\n") }
          }
        } catch {
          // unreadable file — leave as-is
        }
      })

      // 3. Result compaction — v2-format-aware port of v1's "tool.execute.after".
      //    2.0.x carries the model-visible text in result.content[0].text
      //    (result.output is a structured object). Wrapped in try/catch:
      //    a bug here can never break tool results.
      await ctx.tool.hook("execute.after", async (event: any) => {
        try {
          if (event.status !== "completed") return
          const r = event.result
          if (!r || !Array.isArray(r.content) || r.content.length === 0) return
          const part = r.content[0]
          if (!part || part.type !== "text" || typeof part.text !== "string" || !part.text) return
          const out = part.text
          let next: string | null = null

          if (event.tool === "edit") {
            // v1: "Edit applied successfully. *" -> "OK" (single-line confirmation).
            if (!out.includes("\n") && /^Edited \S+ \(\d+ replacement/.test(out)) {
              next = "OK"
            }
          } else if (event.tool === "read") {
            // v1: relativize <path>; only shorten paths under `directory`
            // ("../.." chains for out-of-project reads stay absolute).
            const m = out.match(/^Read file (\S+)/)
            if (m && path.isAbsolute(m[1])) {
              const rel = path.relative(directory, path.normalize(m[1]))
              if (rel && !rel.startsWith("..")) {
                next = out.replace(m[1], rel, 1)
              }
            }
          }

          if (next !== null) {
            event.result = { ...r, content: [{ type: "text", text: next }, ...r.content.slice(1)] }
          }
        } catch {
          // compaction bug must never break tool results
        }
      })
    } else {
      console.warn("[openslimedit] tool.hook API unavailable — line-range edit and result compaction disabled")
    }
  },
}

export default OpenSlimeditV2Plugin
