import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3TextPart,
  LanguageModelV3FilePart,
  LanguageModelV3ReasoningPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider"

type CCMessage =
  | { role: "user"; content: CCUserContent[] }
  | { role: "assistant"; content: CCAssistantContent[] }
  | { role: "tool"; content: CCToolResultContent[] }

type CCUserContent =
  | { type: "text"; text: string }
  | { type: "image"; image: string; mimeType: string }

type CCAssistantContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }

type CCToolResultContent = {
  type: "tool-result"
  toolCallId: string
  toolName: string
  output: { type: "text"; value: string } | { type: "error-text"; value: string }
}

type CCTool = {
  type: "function"
  name: string
  description?: string
  input_schema: unknown
}

interface CCRequestEnvelope {
  config: {
    workingDir: string
    date: string
    environment: string
    structure: unknown[]
    isGitRepo: boolean
    currentBranch: string
    mainBranch: string
    gitStatus: string
    recentCommits: unknown[]
  }
  memory: string
  taste: string
  skills: null
  permissionMode: string
  params: {
    model: string
    messages: CCMessage[]
    tools: CCTool[]
    system: string
    max_tokens: number
    stream: true
    temperature?: number
    top_p?: number
    top_k?: number
    reasoning_effort?: string
  }
}

function hasType(p: unknown, type: string): boolean {
  return typeof p === "object" && p !== null && (p as { type?: string }).type === type
}

function isTextPart(p: unknown): p is LanguageModelV3TextPart {
  return hasType(p, "text")
}

function isReasoningPart(p: unknown): p is LanguageModelV3ReasoningPart {
  return hasType(p, "reasoning")
}

function isToolCallPart(p: unknown): p is LanguageModelV3ToolCallPart {
  return hasType(p, "tool-call")
}

function isToolResultPart(p: unknown): p is LanguageModelV3ToolResultPart {
  return hasType(p, "tool-result")
}

function isFilePart(p: unknown): p is LanguageModelV3FilePart {
  return hasType(p, "file")
}

function fileToDataUrl(part: LanguageModelV3FilePart): string | null {
  const data = part.data
  if (typeof data === "string") {
    if (data.startsWith("data:")) return data
    if (data.startsWith("http://") || data.startsWith("https://")) return data
    return `data:${part.mediaType};base64,${data}`
  }
  if (data instanceof Uint8Array) {
    let binary = ""
    for (const byte of data) binary += String.fromCharCode(byte)
    return `data:${part.mediaType};base64,${btoa(binary)}`
  }
  if (data instanceof URL) return data.toString()
  return null
}

function convertUserContent(content: unknown): CCUserContent[] {
  const parts: CCUserContent[] = []
  if (typeof content === "string") {
    if (content) parts.push({ type: "text", text: content })
    return parts
  }
  if (!Array.isArray(content)) return parts

  let textBuffer = ""
  const flushText = () => {
    if (textBuffer) {
      parts.push({ type: "text", text: textBuffer })
      textBuffer = ""
    }
  }

  for (const part of content) {
    if (isTextPart(part)) {
      textBuffer += (textBuffer ? "\n" : "") + part.text
    } else if (isFilePart(part) && part.mediaType.startsWith("image/")) {
      const dataUrl = fileToDataUrl(part)
      if (dataUrl) {
        flushText()
        parts.push({ type: "image", image: dataUrl, mimeType: part.mediaType })
      }
    }
  }
  flushText()
  return parts
}

function convertToolResultOutput(output: LanguageModelV3ToolResultOutput): CCToolResultContent["output"] {
  switch (output.type) {
    case "text":
      return { type: "text", value: output.value }
    case "error-text":
      return { type: "error-text", value: output.value }
    case "json":
      return { type: "text", value: JSON.stringify(output.value) }
    case "execution-denied":
      return { type: "error-text", value: output.reason ?? "Execution denied" }
    case "error-json":
      return { type: "error-text", value: JSON.stringify(output.value) }
    case "content":
      return { type: "text", value: output.value.map((v: Record<string, unknown>) => ("text" in v ? v.text : JSON.stringify(v))).join("\n") }
    default:
      return { type: "text", value: JSON.stringify(output) }
  }
}

function convertMessage(msg: LanguageModelV3Message): CCMessage | null {
  switch (msg.role) {
    case "user": {
      const content = convertUserContent(msg.content)
      if (content.length === 0) return null
      return { role: "user", content }
    }
    case "assistant": {
      const parts: CCAssistantContent[] = []
      for (const part of msg.content) {
        if (isTextPart(part)) {
          parts.push({ type: "text", text: part.text })
        } else if (isReasoningPart(part)) {
          parts.push({ type: "reasoning", text: part.text })
        } else if (isToolCallPart(part)) {
          parts.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          })
        }
      }
      return { role: "assistant", content: parts }
    }
    case "tool": {
      const parts: CCToolResultContent[] = []
      for (const part of msg.content) {
        if (isToolResultPart(part)) {
          parts.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: convertToolResultOutput(part.output),
          })
        }
      }
      return { role: "tool", content: parts }
    }
    default:
      return null
  }
}

function convertTools(
  tools: Array<LanguageModelV3FunctionTool | { type: "provider"; id: `${string}.${string}`; name: string; args: Record<string, unknown> }> | undefined,
): CCTool[] {
  if (!tools) return []
  return tools
    .filter((t): t is LanguageModelV3FunctionTool => t.type === "function")
    .map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }))
}

export function buildRequest(
  modelId: string,
  options: LanguageModelV3CallOptions,
): CCRequestEnvelope {
  let systemPrompt = ""
  const messages: CCMessage[] = []

  for (const msg of options.prompt) {
    if (msg.role === "system") {
      systemPrompt += (systemPrompt ? "\n\n" : "") + msg.content
      continue
    }
    const converted = convertMessage(msg)
    if (converted) messages.push(converted)
  }

  const params: CCRequestEnvelope["params"] = {
    model: modelId,
    messages,
    tools: convertTools(options.tools),
    system: systemPrompt,
    max_tokens: options.maxOutputTokens ?? 16384,
    stream: true,
  }

  if (options.temperature !== undefined) params.temperature = options.temperature
  if (options.topP !== undefined) params.top_p = options.topP
  if (options.topK !== undefined) params.top_k = options.topK

  const providerOpts = options.providerOptions
  if (providerOpts) {
    const ccOpts = providerOpts.commandcode ?? providerOpts["commandcode-go-opencode-provider"]
    const effort = ccOpts?.reasoningEffort
    if (typeof effort === "string" && effort.length > 0) {
      params.reasoning_effort = effort
    }
  }

  return {
    config: {
      workingDir: process.cwd() ?? "/",
      date: new Date().toISOString().split("T")[0] ?? "",
      environment: `${process.platform}-${process.arch}`,
      // Stub: opencode does not expose project structure context
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: "",
    // Stub: taste/memory/permissionMode are Command Code CLI features not exposed via provider API
    taste: "",
    skills: null,
    permissionMode: "standard",
    params,
  }
}
