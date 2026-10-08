// Port to the OpenCode V2 plugin API. OpenCode V2 rejects V1 hook objects
// ("Plugin must export a default definition with an id and a setup function"),
// so this version registers the equivalent V2 hooks instead:
//
//   V1 tool.definition     -> V2 ctx.session.hook("context")     (tool descriptions)
//   V1 tool.execute.before -> V2 ctx.tool.hook("execute.before") (line-range expansion)
//   V1 tool.execute.after  -> V2 ctx.tool.hook("execute.after")  (compact output)
//
// V1 -> V2 renames covered: filePath -> path (edit tool input), bash -> shell,
// fetch -> webfetch (tool names).
// Every hook is fail-open: on any error the original behavior is kept.
import * as fs from "fs"
import * as path from "path"
const LINE_RANGE_RE = /^(\d+)(?:\s*-\s*(\d+))?$/

const SLIM: Record<string, string> = {
  read: "Read file content.",
  edit: "Edit file. oldString can be line range '55-64'.",
  apply_patch: "Apply a patch to files.",
  patch: "Apply a patch to files.",
  write: "Write file.",
  bash: "Run shell command.",
  shell: "Run shell command.",
  glob: "Find files.",
  grep: "Search in files.",
  list: "List directory.",
  fetch: "Fetch URL.",
  webfetch: "Fetch URL.",
}

export const OpenSlimeditPlugin = {
  id: "openslimedit",
  async setup(ctx: any) {
    const directory: string = ctx?.location?.directory || process.cwd()

    function resolvePath(filePath: string): string {
      if (path.isAbsolute(filePath)) return path.normalize(filePath)
      return path.resolve(directory, filePath)
    }

    // Shorten tool descriptions on every dispatch
    await ctx.session.hook("context", async (event: any) => {
      try {
        for (const name of Object.keys(SLIM)) {
          const tool = event.tools && event.tools[name]
          if (tool) tool.description = SLIM[name]
        }
      } catch {
        /* fail-open */
      }
    })

    // Compact tool output: shorten read paths, strip footer, compress edit results
    await ctx.tool.hook("execute.after", async (event: any) => {
      try {
        if (event.status !== "completed") return
        const result = event.result
        if (!result || result.content == null) return

        // The result text lives either in `content` (string) or in a
        // [{ type: "text", text }] content part.
        let slot: { value: string; commit: (t: string) => void } | null = null
        if (typeof result.content === "string") {
          slot = {
            value: result.content,
            commit: (t: string) => {
              event.result = { ...result, content: t }
            },
          }
        } else if (Array.isArray(result.content)) {
          const i = result.content.findIndex(
            (p: any) => p && p.type === "text" && typeof p.text === "string",
          )
          if (i < 0) return
          slot = {
            value: result.content[i].text,
            commit: (t: string) => {
              const content = [...result.content]
              content[i] = { ...content[i], text: t }
              event.result = { ...result, content }
            },
          }
        } else return

        let text = slot.value

        // Compress edit output
        if (event.tool === "edit") {
          if (text.startsWith("Edit applied successfully.")) {
            slot.commit("OK")
          }
          return
        }

        if (event.tool !== "read") return
        if (text.includes("<type>directory</type>")) return

        const pathMatch = text.match(/<path>(.+?)<\/path>/)
        if (!pathMatch) return

        // Shorten to relative path
        const absPath = path.normalize(pathMatch[1])
        const relPath = path.relative(directory, absPath)
        text = text.replace(`<path>${pathMatch[1]}</path>`, `<path>${relPath}</path>`)

        // Remove type tag and footer
        text = text.replace("<type>file</type>\n", "")
        text = text.replace(/\n\n\(End of file - total \d+ lines\)\n/, "\n")
        slot.commit(text)
      } catch {
        /* fail-open */
      }
    })

    // Expand line ranges in oldString
    await ctx.tool.hook("execute.before", async (event: any) => {
      try {
        if (event.tool !== "edit") return
        const args = event.input
        if (!args || typeof args !== "object") return
        // V1 read args.filePath; the V2 edit tool uses args.path
        const filePath = args.filePath || args.path
        if (!args.oldString || !filePath) return

        let content: string
        try {
          content = fs.readFileSync(resolvePath(filePath), "utf-8")
        } catch {
          return
        }

        if (content.includes(args.oldString)) return

        const match = String(args.oldString).trim().match(LINE_RANGE_RE)
        if (!match) return

        const lines = content.split("\n")
        const startLine = parseInt(match[1], 10)
        const endLine = match[2] ? parseInt(match[2], 10) : startLine

        if (startLine >= 1 && endLine <= lines.length && startLine <= endLine) {
          args.oldString = lines.slice(startLine - 1, endLine).join("\n")
          event.input = args
        }
      } catch {
        /* fail-open */
      }
    })
  },
}

export default OpenSlimeditPlugin
