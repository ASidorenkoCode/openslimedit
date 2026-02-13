import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as path from "path"

const z = tool.schema

/**
 * djb2 hash of trimmed line content, truncated to 3 hex chars.
 * 3 hex chars = 4096 values. Collisions are rare and disambiguated by line number.
 */
function hashLine(content: string): string {
  const trimmed = content.trimEnd()
  let h = 5381
  for (let i = 0; i < trimmed.length; i++) {
    h = ((h << 5) + h + trimmed.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).slice(-3).padStart(3, "0")
}

/** Per-file mapping: hash ref (e.g. "42:a3f") → line content */
const fileHashes = new Map<string, Map<string, string>>()

export const HashlinePlugin: Plugin = async ({ directory }) => {
  function resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) return path.normalize(filePath)
    return path.resolve(directory, filePath)
  }

  /** Read file from disk and compute fresh hashes */
  function computeFileHashes(filePath: string): Map<string, string> {
    const content = fs.readFileSync(filePath, "utf-8")
    const lines = content.split("\n")
    const hashes = new Map<string, string>()
    for (let i = 0; i < lines.length; i++) {
      const hash = hashLine(lines[i])
      hashes.set(`${i + 1}:${hash}`, lines[i])
    }
    fileHashes.set(filePath, hashes)
    return hashes
  }

  return {
    // ── Read: tag each line with its content hash ──────────────────────
    "tool.execute.after": async (input, output) => {
      if (input.tool === "edit") {
        // Invalidate stored hashes after any edit
        const filePath = resolvePath(input.args.filePath)
        fileHashes.delete(filePath)
        return
      }

      if (input.tool !== "read") return

      // Skip directory reads
      if (output.output.includes("<type>directory</type>")) return

      // Extract absolute file path from output and normalize it
      const pathMatch = output.output.match(/<path>(.+?)<\/path>/)
      if (!pathMatch) return
      const filePath = path.normalize(pathMatch[1])

      // Transform content lines: "N: content" → "N:hash| content"
      // The first line is concatenated with <content> (no newline), so we
      // match an optional <content> prefix and preserve it in the output.
      const hashes = new Map<string, string>()
      output.output = output.output.replace(
        /^(<content>)?(\d+): (.*)$/gm,
        (
          _match,
          prefix: string | undefined,
          lineNum: string,
          content: string,
        ) => {
          const hash = hashLine(content)
          const ref = `${lineNum}:${hash}`
          hashes.set(ref, content)
          return `${prefix ?? ""}${lineNum}:${hash}| ${content}`
        },
      )

      if (hashes.size > 0) {
        // Merge with existing hashes (supports partial reads / offset reads)
        const existing = fileHashes.get(filePath)
        if (existing) {
          for (const [ref, content] of hashes) {
            existing.set(ref, content)
          }
        } else {
          fileHashes.set(filePath, hashes)
        }
      }
    },

    // ── Edit schema: replace oldString/newString with hash references ──
    // Requires PR #4956 (tool.definition hook) to take effect.
    "tool.definition": async (input: any, output: any) => {
      if (input.toolID !== "edit") return
      output.description = [
        "Edit a file using hashline references from the most recent read output.",
        "Each line is tagged as `<line>:<hash>| <content>`.",
        "",
        "Three operations:",
        "1. Replace line:  startHash only → replaces that single line",
        "2. Replace range: startHash + endHash → replaces all lines in range",
        "3. Insert after:  afterHash → inserts content after that line (no replacement)",
      ].join("\n")
      output.parameters = z.object({
        filePath: z.string().describe("The absolute path to the file to modify"),
        startHash: z
          .string()
          .optional()
          .describe(
            'Hash reference for the start line to replace (e.g. "42:a3f")',
          ),
        endHash: z
          .string()
          .optional()
          .describe(
            "Hash reference for the end line (for multi-line range replacement)",
          ),
        afterHash: z
          .string()
          .optional()
          .describe(
            "Hash reference for the line to insert after (no replacement)",
          ),
        content: z
          .string()
          .describe("The new content to insert or replace with"),
      })
    },

    // ── System prompt: instruct the model to use hashline edits ────────
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      output.system.push(
        [
          "## Hashline Edit Mode (MANDATORY)",
          "",
          "When you read a file, each line is tagged with a hash: `<lineNumber>:<hash>| <content>`.",
          "You MUST use these hash references when editing files. Do NOT use oldString/newString.",
          "",
          "Three operations:",
          "",
          "1. **Replace line** — replace a single line:",
          '   `startHash: "3:cc7", content: "  \\"version\\": \\"1.0.0\\","` ',
          "",
          "2. **Replace range** — replace lines startHash through endHash:",
          '   `startHash: "3:cc7", endHash: "5:e60", content: "line3\\nline4\\nline5"`',
          "",
          "3. **Insert after** — insert new content after a line (without replacing it):",
          '   `afterHash: "3:cc7", content: "  \\"newKey\\": \\"newValue\\","` ',
          "",
          "NEVER pass oldString or newString. ALWAYS use startHash/afterHash + content.",
        ].join("\n"),
      )
    },

    // ── Edit: resolve hash references before the built-in edit runs ────
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "edit") return

      const args = output.args

      // Reject oldString edits for files we have hashes for — force hashline usage
      if (args.oldString && !args.startHash) {
        const filePath = resolvePath(args.filePath)
        if (fileHashes.has(filePath)) {
          throw new Error(
            [
              "You must use hashline references to edit this file.",
              "Use startHash (e.g. \"3:cc7\") instead of oldString.",
              "Refer to the hash markers from the read output.",
            ].join(" "),
          )
        }
        // No hashes for this file — allow normal edit
        return
      }

      // Only intercept hashline edits; fall through for normal edits
      if (!args.startHash && !args.afterHash) return

      // ── Insert after: append content after the referenced line ──
      if (args.afterHash) {
        const filePath = resolvePath(args.filePath)
        let hashes = fileHashes.get(filePath)
        if (!hashes) {
          try {
            hashes = computeFileHashes(filePath)
          } catch {
            return
          }
        }
        if (!hashes.has(args.afterHash)) {
          try {
            hashes = computeFileHashes(filePath)
          } catch {
            throw new Error(
              `Cannot read file "${args.filePath}" to verify hash references.`,
            )
          }
          if (!hashes.has(args.afterHash)) {
            fileHashes.delete(filePath)
            throw new Error(
              `Hash reference "${args.afterHash}" not found. The file may have changed since last read. Please re-read the file.`,
            )
          }
        }

        const anchorContent = hashes.get(args.afterHash)!
        // oldString = anchor line, newString = anchor line + new content
        args.oldString = anchorContent
        args.newString = anchorContent + "\n" + args.content

        delete args.afterHash
        delete args.content
        return
      }

      const filePath = resolvePath(args.filePath)
      let hashes = fileHashes.get(filePath)

      // No stored hashes → try reading the file fresh
      if (!hashes) {
        try {
          hashes = computeFileHashes(filePath)
        } catch {
          // Can't read file — fall through to normal edit behavior
          return
        }
      }

      // Validate startHash; if stale, re-read and retry once
      if (!hashes.has(args.startHash)) {
        try {
          hashes = computeFileHashes(filePath)
        } catch {
          throw new Error(
            `Cannot read file "${args.filePath}" to verify hash references.`,
          )
        }
        if (!hashes.has(args.startHash)) {
          fileHashes.delete(filePath)
          throw new Error(
            `Hash reference "${args.startHash}" not found. The file may have changed since last read. Please re-read the file.`,
          )
        }
      }

      const startLine = parseInt(args.startHash.split(":")[0], 10)
      const endLine = args.endHash
        ? parseInt(args.endHash.split(":")[0], 10)
        : startLine

      // Validate endHash
      if (args.endHash && !hashes.has(args.endHash)) {
        fileHashes.delete(filePath)
        throw new Error(
          `Hash reference "${args.endHash}" not found. The file may have changed since last read. Please re-read the file.`,
        )
      }

      if (endLine < startLine) {
        throw new Error(
          `endHash line (${endLine}) must be >= startHash line (${startLine})`,
        )
      }

      // Build oldString from the line range
      const rangeLines: string[] = []
      for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
        let found = false
        for (const [ref, content] of hashes) {
          if (ref.startsWith(`${lineNum}:`)) {
            rangeLines.push(content)
            found = true
            break
          }
        }
        if (!found) {
          fileHashes.delete(filePath)
          throw new Error(
            `No hash found for line ${lineNum} in range ${startLine}-${endLine}. The file may have changed. Please re-read the file.`,
          )
        }
      }

      const oldString = rangeLines.join("\n")

      // Set resolved args for the built-in edit tool
      args.oldString = oldString
      args.newString = args.content

      // Remove hashline-specific fields so the built-in edit doesn't choke
      delete args.startHash
      delete args.endHash
      delete args.content
    },
  } as any
}

export default HashlinePlugin
