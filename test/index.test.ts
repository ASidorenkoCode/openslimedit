import { expect, test } from "bun:test"
import plugin from "../src/index"

// Runs the plugin's execute.after hook against a fake tool result.
async function after(tool: string, result: Record<string, unknown>) {
  let hook: ((event: any) => any) | undefined
  await plugin.setup({
    location: { directory: process.cwd() },
    tool: {
      transform: async () => {},
      hook: async (name: string, fn: (event: any) => any) => {
        if (name === "execute.after") hook = fn
      },
    },
  } as any)
  await hook!({ tool, status: "completed", result })
  return result
}

test("edit content parts become OK and keep metadata", async () => {
  const result = await after("edit", {
    output: { replacements: 1 },
    content: [{ type: "text", text: "Edited sample.ts (1 replacement)" }],
  })
  expect((result.content as any)[0].text).toBe("OK")
  expect(result.output).toEqual({ replacements: 1 })
})

test("edit content string becomes OK", async () => {
  const result = await after("edit", { content: "Edited sample.ts (2 replacements)" })
  expect(result.content).toBe("OK")
})

test("edit output string becomes OK", async () => {
  const result = await after("edit", { output: "Edited sample.ts (1 replacement)" })
  expect(result.output).toBe("OK")
})

test("other Edited messages are left alone", async () => {
  const result = await after("edit", { content: "Edited something else" })
  expect(result.content).toBe("Edited something else")
})

test("non-edit tools are left alone", async () => {
  const result = await after("patch", { content: "Edited sample.ts (1 replacement)" })
  expect(result.content).toBe("Edited sample.ts (1 replacement)")
})
