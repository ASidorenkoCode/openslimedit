import { Plugin } from "@opencode/plugin"
import * as fs from "node:fs"
import * as path from "node:path"

const LINE_RANGE_RE = /^(\d+)(?:\s*-\s*(\d+))?$/
// V2 success text: "Edited <file> (<n> replacement|replacements)"
const EDIT_RESULT_RE = /^Edited .+ \(\d+ replacements?\)$/

const SLIM_DESCRIPTIONS: Record<string, string> = {
  read: "Read file content.",
  edit: "Edit file. oldString can be a line range like '55-64'.",
  write: "Write file.",
  shell: "Run a shell command.",
  patch: "Apply a patch to files.",
  apply_patch: "Apply a patch to files.",
  glob: "Find files.",
  grep: "Search in files.",
  fetch: "Fetch a URL.",
}

type EditInput = {
  path?: unknown
  oldString?: unknown
  [key: string]: unknown
}

type ToolResult = {
  output?: unknown
  content?: unknown
  [key: string]: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined
  return value as Record<string, unknown>
}

function asEditInput(value: unknown): EditInput | undefined {
  const input = asRecord(value)
  if (!input) return undefined
  return input as EditInput
}

function asToolResult(value: unknown): ToolResult | undefined {
  const result = asRecord(value)
  if (!result) return undefined
  return result as ToolResult
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  )
}

function textOutput(result: ToolResult): string | undefined {
  if (typeof result.output === "string") return result.output
  if (typeof result.content === "string") return result.content
  if (!Array.isArray(result.content)) return undefined
  return result.content.filter(isTextPart).map(part => part.text).join("")
}

// V2 hands edit results over as a content parts array, so both shapes must be replaceable.
function replaceTextOutput(result: ToolResult, text: string): boolean {
  if (typeof result.content === "string") {
    result.content = text
    return true
  }
  if (Array.isArray(result.content)) {
    const part = result.content.find(isTextPart)
    if (part) part.text = text
    return part !== undefined
  }
  if (typeof result.output === "string") {
    result.output = text
    return true
  }
  return false
}

function compactReadOutput(output: string, directory: string): string {
  if (output.includes("<type>directory</type>")) return output

  // OpenCode V2's built-in read tool uses a plain-text envelope.
  const v2PathMatch = output.match(/^Read file (.+?), lines \d+-\d+\n/)
  if (v2PathMatch) {
    const absPath = path.normalize(v2PathMatch[1])
    const relPath = path.relative(directory, absPath)
    return `Read file ${relPath}\n${output.slice(v2PathMatch[0].length)}`
  }

  // Keep compatibility with the V1 XML-style read envelope.
  const pathMatch = output.match(/<path>(.+?)<\/path>/)
  if (!pathMatch) return output

  const absPath = path.normalize(pathMatch[1])
  const relPath = path.relative(directory, absPath)
  let compacted = output.replace(`<path>${pathMatch[1]}</path>`, `<path>${relPath}</path>`)
  compacted = compacted.replace("<type>file</type>\n", "")
  return compacted.replace(/\n\n\(End of file - total \d+ lines\)\n/, "\n")
}

function expandLineRange(input: EditInput, directory: string): void {
  if (typeof input.path !== "string" || typeof input.oldString !== "string") return

  const filePath = path.isAbsolute(input.path)
    ? path.normalize(input.path)
    : path.resolve(directory, input.path)

  let content: string
  try {
    content = fs.readFileSync(filePath, "utf-8")
  } catch {
    return
  }

  if (content.includes(input.oldString)) return

  const match = input.oldString.trim().match(LINE_RANGE_RE)
  if (!match) return

  const lines = content.split("\n")
  const startLine = Number.parseInt(match[1], 10)
  const endLine = match[2] ? Number.parseInt(match[2], 10) : startLine

  if (startLine >= 1 && endLine <= lines.length && startLine <= endLine) {
    input.oldString = lines.slice(startLine - 1, endLine).join("\n")
  }
}

export default Plugin.define({
  id: "openslimedit",

  async setup(ctx) {
    const directory = ctx.location.directory

    await ctx.tool.transform(editor => {
      for (const id of Object.keys(SLIM_DESCRIPTIONS)) {
        editor.update(id, tool => {
          tool.description = SLIM_DESCRIPTIONS[id]
        })
      }
    })

    await ctx.tool.hook("execute.before", event => {
      if (event.tool !== "edit") return
      const input = asEditInput(event.input)
      if (input) expandLineRange(input, directory)
    })

    await ctx.tool.hook("execute.after", event => {
      if (event.status !== "completed") return
      const result = asToolResult(event.result)
      if (!result) return

      if (event.tool === "edit") {
        const output = textOutput(result)
        if (output && EDIT_RESULT_RE.test(output)) replaceTextOutput(result, "OK")
        return
      }

      if (event.tool !== "read") return
      const output = textOutput(result)
      if (!output) return
      const compacted = compactReadOutput(output, directory)
      if (compacted === output) return

      replaceTextOutput(result, compacted)
    })
  },
})
