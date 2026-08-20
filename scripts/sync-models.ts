import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { execSync } from "child_process"

const PROJECT_ROOT = join(import.meta.dir, "..")
const MODELS_JSON = join(PROJECT_ROOT, "models.json")
const GLOBAL_CONFIG = join(homedir(), ".config", "opencode", "opencode.jsonc")
const NPM_PACKAGE = "command-code"
const TMP_DIR = join("/tmp", "cc-model-sync")

interface ModelEntry {
  id: string
  name: string
  tier: "premium" | "open-source"
  reasoning: boolean
  reasoningEfforts?: string[]
  tool_call: boolean
  cost: { input: number; output: number; cache_read?: number; cache_write?: number }
  limit: { context: number; output: number }
}

interface CostEntry {
  id: string
  provider: string
  category: string
  promptCost: number
  completionCost: number
  cacheWrite5mCost: number
  cacheWrite1hCost: number
  cacheHitCost: number
}

interface NewCostEntry {
  id: string
  promptCost: number
  completionCost: number
  cacheReadCost?: number
  cacheWriteCost?: number
}

interface SnEntry {
  id: string
  provider: string
  spec: string
  label: string
  name: string
  description: string
  reasoning?: boolean
  reasoningEfforts?: string[]
  contextWindow?: number
  hidden?: boolean
}

interface PricingProvider {
  slug: string
  promptCost: number
  completionCost: number
  cacheReadCost?: number
  cacheWriteCost?: number
}

interface PricingEntry {
  canonicalId: string
  gatewaySlug?: string
  order?: string[]
  providers: Record<string, PricingProvider>
}

interface PricedCost {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}

const FALLBACK_COSTS: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }> = {
  "deepseek/deepseek-v4-pro": { input: 0.435, output: 0.87, cache_read: 0.003625 },
  "deepseek/deepseek-v4-flash": { input: 0.14, output: 0.28, cache_read: 0.01 },
  "zai-org/GLM-5.1": { input: 1.4, output: 4.4, cache_read: 0.26 },
  "MiniMaxAI/MiniMax-M2.7": { input: 0.3, output: 1.2, cache_read: 0.06 },
  "Qwen/Qwen3.6-Max-Preview": { input: 1.3, output: 7.8, cache_read: 0.26, cache_write: 1.63 },
  "Qwen/Qwen3.6-Plus": { input: 0.5, output: 3, cache_read: 0.1 },
  "Qwen/Qwen3.7-Max": { input: 1.25, output: 3.75, cache_read: 0.25, cache_write: 1.56 },
  "stepfun/Step-3.5-Flash": { input: 0.1, output: 0.3, cache_read: 0.02 },
  "google/gemini-3.5-flash": { input: 1.5, output: 9, cache_read: 0.15 },
  "google/gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cache_read: 0.03 },
}

const FALLBACK_LIMITS: Record<string, { context: number; output: number }> = {
  "claude-haiku-4-5-20251001": { context: 200000, output: 8192 },
  "claude-opus-4-6": { context: 200000, output: 32000 },
  "claude-opus-4-7": { context: 200000, output: 32000 },
  "claude-sonnet-4-6": { context: 200000, output: 16000 },
  "gpt-5.5": { context: 256000, output: 128000 },
  "gpt-5.4": { context: 256000, output: 128000 },
  "gpt-5.3-codex": { context: 256000, output: 128000 },
  "gpt-5.4-mini": { context: 256000, output: 128000 },
  "moonshotai/Kimi-K2.6": { context: 262144, output: 131072 },
  "moonshotai/Kimi-K2.5": { context: 262144, output: 131072 },
  "zai-org/GLM-5": { context: 200000, output: 131072 },
  "zai-org/GLM-5.1": { context: 200000, output: 131072 },
  "MiniMaxAI/MiniMax-M2.5": { context: 1000000, output: 131072 },
  "MiniMaxAI/MiniMax-M2.7": { context: 1000000, output: 131072 },
  "deepseek/deepseek-v4-pro": { context: 1000000, output: 384000 },
  "deepseek/deepseek-v4-flash": { context: 1000000, output: 384000 },
  "Qwen/Qwen3.6-Max-Preview": { context: 1000000, output: 131072 },
  "Qwen/Qwen3.6-Plus": { context: 1000000, output: 131072 },
  "Qwen/Qwen3.7-Max": { context: 1000000, output: 131072 },
  "stepfun/Step-3.5-Flash": { context: 1000000, output: 131072 },
  "google/gemini-3.5-flash": { context: 1000000, output: 65536 },
  "google/gemini-3.1-flash-lite": { context: 1000000, output: 65536 },
}

const HARDCODED_EXTRAS: SnEntry[] = [
  {
    id: "Qwen/Qwen3.7-Max",
    provider: "vercel-ai-gateway",
    spec: "chatComplete",
    label: "Qwen 3.7 Max",
    name: "Qwen 3.7 Max",
    description: "latest Qwen Max model",
    reasoning: true,
  },
]

const TIER_MAP: Record<string, "premium" | "open-source"> = {
  "anthropic": "premium",
  "openai": "premium",
  "baseten": "open-source",
  "vercel-ai-gateway": "open-source",
  "openrouter": "open-source",
  "cloudflare-ai-gateway": "open-source",
}

async function fetchLatestBundle(): Promise<{ source: string; version: string }> {
  console.log(`Fetching latest ${NPM_PACKAGE} metadata...`)
  const metaResp = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`)
  if (!metaResp.ok) throw new Error(`npm registry returned ${metaResp.status}`)
  const meta = await metaResp.json()
  const version = meta.version as string
  const tarball = meta.dist.tarball as string
  console.log(`  Latest version: ${version}`)
  console.log(`  Tarball: ${tarball}`)

  mkdirSync(TMP_DIR, { recursive: true })
  const tgzPath = join(TMP_DIR, `${NPM_PACKAGE}.tgz`)

  console.log("Downloading tarball...")
  const tarballResp = await fetch(tarball)
  if (!tarballResp.ok) throw new Error(`tarball download returned ${tarballResp.status}`)
  const buffer = Buffer.from(await tarballResp.arrayBuffer())
  writeFileSync(tgzPath, buffer)

  console.log("Extracting...")
  execSync(`tar -xzf "${tgzPath}" -C "${TMP_DIR}"`, { stdio: "pipe" })

  const bundlePath = join(TMP_DIR, "package", "dist", "cli.mjs")
  if (!existsSync(bundlePath)) throw new Error(`Bundle not found at ${bundlePath}`)

  const source = readFileSync(bundlePath, "utf-8")

  rmSync(TMP_DIR, { recursive: true, force: true })

  return { source, version }
}

function findBalancedObject(source: string, anchor: string): string {
  const anchorIdx = source.indexOf(anchor)
  if (anchorIdx < 0) throw new Error(`Anchor not found: ${anchor}`)

  let parenIdx = anchorIdx - 1
  while (parenIdx >= 0 && source[parenIdx] !== "(") parenIdx--
  if (parenIdx < 0) throw new Error(`Could not find opening ( before anchor: ${anchor}`)

  const braceStart = source.indexOf("{", parenIdx)
  if (braceStart < 0) throw new Error(`Could not find { after opening (`)

  let depth = 0
  let end = braceStart
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++
    else if (source[end] === "}") {
      depth--
      if (depth === 0) break
    }
  }

  return source.slice(braceStart, end + 1)
}

function evaluateWithContext(code: string, context: Record<string, unknown>): any {
  const keys = Object.keys(context)
  const values = keys.map((k) => context[k])
  const fn = Function(...keys, `"use strict"; return (${code})`)
  return fn(...values)
}

function extractWt(source: string): Record<string, string> {
  const raw = findBalancedObject(source, 'ANTHROPIC:"anthropic"')
  return evaluateWithContext(normalizeForEval(raw), {})
}

function extractSpecConstants(source: string): { chatComplete: string; responses: string; qt: string } {
  const anchorIdx = source.indexOf('SONNET_4_6:{id:"claude-sonnet-4-6"')
  if (anchorIdx < 0) throw new Error("Could not find model catalog anchor")

  const before = source.slice(Math.max(0, anchorIdx - 5000), anchorIdx)

  const chatMatch = before.match(/([A-Za-z_$]+)="chatComplete"/)
  const respMatch = before.match(/([A-Za-z_$]+)="responses"/)
  if (!chatMatch || !respMatch) throw new Error("Could not find spec constants")

  const qtMatch = before.match(/([A-Za-z_$]+)=Vt\[0\]/)
  const qtVar = qtMatch ? qtMatch[1] : null

  return {
    chatComplete: chatMatch[1],
    responses: respMatch[1],
    qt: qtVar || "",
  }
}

function extractConsts(source: string): Record<string, string> {
  const anchorIdx = source.indexOf('SONNET_5:{id:')
  if (anchorIdx < 0) throw new Error("Could not find model catalog anchor")

  const before = source.slice(Math.max(0, anchorIdx - 30000), anchorIdx)

  const consts: Record<string, string> = {}
  const stringRe = /([A-Za-z_$][A-Za-z0-9_$]*)=\"([^\"]*)\"/g
  let m: RegExpExecArray | null
  while ((m = stringRe.exec(before))) {
    const [, name, value] = m
    if (name && value) consts[name] = value
  }

  const aliasRe = /([A-Za-z_$][A-Za-z0-9_$]*)=([A-Za-z_$][A-Za-z0-9_$]*)/g
  let resolved = true
  while (resolved) {
    resolved = false
    while ((m = aliasRe.exec(before))) {
      const [, name, target] = m
      if (name && target && consts[target] && !consts[name]) {
        consts[name] = consts[target]
        resolved = true
      }
    }
    aliasRe.lastIndex = 0
  }

  return consts
}

function extractModelCatalog(
  source: string,
  consts: Record<string, string>,
): Record<string, SnEntry> {
  const raw = findBalancedObject(source, 'SONNET_5:{id:')
  const ctx: Record<string, unknown> = { ...consts }
  ctx.isLingFlashFreeEnded = () => true
  return evaluateWithContext(normalizeForEval(raw), ctx)
}

function extractCostData(source: string, consts: Record<string, string>): Record<string, CostEntry[]> {
  const anchor = '{id:"anthropic:claude-sonnet-4-'
  const anchorIdx = source.indexOf(anchor)
  if (anchorIdx < 0) throw new Error("Could not find cost data anchor")

  let braceDepth = 0
  let start = anchorIdx - 1
  for (; start >= 0; start--) {
    if (source[start] === "}") braceDepth++
    else if (source[start] === "{") {
      if (braceDepth === 0) break
      braceDepth--
    }
  }

  let depth = 0
  let end = start
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++
    else if (source[end] === "}") {
      depth--
      if (depth === 0) break
    }
  }

  const raw = source.slice(start, end + 1)
  return evaluateWithContext(normalizeForEval(raw), consts) as Record<string, CostEntry[]>
}

function extractArrayPricing(
  source: string,
  anchorIdx: number,
  consts: Record<string, string>,
): PricingEntry[] {
  const bracketIdx = source.indexOf("[", anchorIdx)
  if (bracketIdx < 0) return []

  let depth = 0
  let end = bracketIdx
  for (; end < source.length; end++) {
    if (source[end] === "[") depth++
    else if (source[end] === "]") {
      depth--
      if (depth === 0) break
    }
  }

  const raw = source.slice(bracketIdx + 1, end)

  const ctx: Record<string, unknown> = { ...consts }
  const ctxWindow = source.slice(Math.max(0, anchorIdx - 1500), anchorIdx + 300)
  const dateMatch = ctxWindow.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/)
  if (dateMatch) ctx[dateMatch[1]] = dateMatch[2]
  const windowMatch = ctxWindow.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\[(\{startHourUtc:[^\]]*)\]/, "s")
  if (windowMatch) {
    ctx[windowMatch[1]] = evaluateWithContext(normalizeForEval(`[${windowMatch[2]}]`), {})
  }

  return evaluateWithContext(normalizeForEval(`[${raw}]`), ctx) as PricingEntry[]
}

function extractNewCostData(source: string, consts: Record<string, string>): PricingEntry[] {
  const results: PricingEntry[] = []
  const re = /=\s*\[\{canonicalId:"[^"]+",(?:gatewaySlug|openrouterSlug):/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    const anchorIdx = m.index + 1
    results.push(...extractArrayPricing(source, anchorIdx, consts))
  }
  return results
}

function normalizePricing(entry: PricingEntry): NewCostEntry {
  const providers = Object.values(entry.providers).filter((p) => p.promptCost !== undefined)
  const sorted = providers.sort((a, b) => {
    const ca = a.promptCost + a.completionCost
    const cb = b.promptCost + b.completionCost
    return ca - cb
  })
  const pick = sorted[0]
  return {
    id: entry.canonicalId,
    promptCost: pick.promptCost,
    completionCost: pick.completionCost,
    cacheReadCost: pick.cacheReadCost,
    cacheWriteCost: pick.cacheWriteCost,
  }
}

function getWtVarName(source: string): string {
  return ""
}

function normalizeForEval(code: string): string {
  return code
    .replace(/!0/g, "true")
    .replace(/!1/g, "false")
    .replace(/(\d+)e(\d+)/g, (_: string, m: string, e: string) =>
      String(Number(m) * Math.pow(10, Number(e)))
    )
}

function buildCostMap(
  costs: Record<string, CostEntry[]>,
  newCosts: NewCostEntry[],
): Map<string, { promptCost: number; completionCost: number; cacheReadCost?: number; cacheWriteCost?: number }> {
  const map = new Map<string, { promptCost: number; completionCost: number; cacheReadCost?: number; cacheWriteCost?: number }>()
  for (const arr of Object.values(costs)) {
    for (const entry of arr) {
      const colonIdx = entry.id.indexOf(":")
      const bareId = colonIdx >= 0 ? entry.id.slice(colonIdx + 1) : entry.id
      map.set(bareId, {
        promptCost: entry.promptCost,
        completionCost: entry.completionCost,
        cacheReadCost: entry.cacheHitCost > 0 ? entry.cacheHitCost : undefined,
        cacheWriteCost: entry.cacheWrite5mCost > 0 ? entry.cacheWrite5mCost : undefined,
      })
    }
  }
  for (const entry of newCosts) {
    if (!map.has(entry.id)) {
      map.set(entry.id, {
        promptCost: entry.promptCost,
        completionCost: entry.completionCost,
        cacheReadCost: entry.cacheReadCost,
        cacheWriteCost: entry.cacheWriteCost,
      })
    }
  }
  return map
}

function buildModelEntry(
  entry: SnEntry,
  costMap: Map<string, { promptCost: number; completionCost: number; cacheReadCost?: number; cacheWriteCost?: number }>,
): ModelEntry | null {
  const provider = entry.provider || "unknown"
  const tier = TIER_MAP[provider] ?? "open-source"

  const costEntry = costMap.get(entry.id)
  let cost: { input: number; output: number; cache_read?: number; cache_write?: number }
  if (costEntry) {
    cost = {
      input: costEntry.promptCost,
      output: costEntry.completionCost,
    }
    if (costEntry.cacheReadCost && costEntry.cacheReadCost > 0) cost.cache_read = costEntry.cacheReadCost
    if (costEntry.cacheWriteCost && costEntry.cacheWriteCost > 0) cost.cache_write = costEntry.cacheWriteCost
  } else {
    const fallback = FALLBACK_COSTS[entry.id]
    if (!fallback) return null
    cost = fallback
  }

  const limit = entry.contextWindow
    ? { context: entry.contextWindow, output: FALLBACK_LIMITS[entry.id]?.output ?? 65536 }
    : FALLBACK_LIMITS[entry.id] ?? { context: 200000, output: 65536 }

  return {
    id: entry.id,
    name: entry.name,
    tier,
    reasoning: entry.reasoning || (entry.reasoningEfforts?.length ?? 0) > 0,
    reasoningEfforts: entry.reasoningEfforts,
    tool_call: true,
    cost,
    limit,
  }
}

function toConfigKey(id: string): string {
  const slashIdx = id.indexOf("/")
  const short = slashIdx >= 0 ? id.slice(slashIdx + 1) : id
  return short.toLowerCase()
}

function generateOpencodeModels(entries: ModelEntry[]): Record<string, unknown> {
  const models: Record<string, unknown> = {}
  for (const entry of entries) {
    const key = toConfigKey(entry.id)
    const costObj: Record<string, number> = { input: entry.cost.input, output: entry.cost.output }
    if (entry.cost.cache_read !== undefined) costObj.cache_read = entry.cost.cache_read
    if (entry.cost.cache_write !== undefined) costObj.cache_write = entry.cost.cache_write

    models[key] = {
      id: entry.id,
      name: entry.name,
      reasoning: entry.reasoning,
      tool_call: entry.tool_call,
      cost: costObj,
      limit: entry.limit,
      ...(entry.reasoningEfforts && entry.reasoningEfforts.length > 0
        ? {
            variants: Object.fromEntries(
              entry.reasoningEfforts.map((effort) => [effort, { reasoningEffort: effort }]),
            ),
          }
        : {}),
    }
  }
  return models
}

function stripJsonc(input: string): string {
  let out = ""
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === '"') {
      const start = i
      i++
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\") i++
        i++
      }
      i++
      out += input.slice(start, i)
    } else if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++
    } else if (ch === "/" && input[i + 1] === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++
      i += 2
    } else {
      out += ch
      i++
    }
  }
  return out.replace(/,\s*([}\]])/g, "$1")
}

function updateGlobalConfig(modelsObj: Record<string, unknown>) {
  if (!existsSync(GLOBAL_CONFIG)) {
    console.log(`  Global config not found at ${GLOBAL_CONFIG}, skipping`)
    return
  }

  const raw = readFileSync(GLOBAL_CONFIG, "utf-8")
  const jsonStr = stripJsonc(raw)

  let config: any
  try {
    config = JSON.parse(jsonStr)
  } catch {
    console.error("  Failed to parse global config as JSON after stripping comments")
    return
  }

  if (!config.provider) config.provider = {}
  if (!config.provider.commandcode) {
    config.provider.commandcode = {
      npm: "commandcode-go-opencode-provider",
      name: "Command Code",
      env: ["COMMANDCODE_API_KEY"],
    }
  }
  config.provider.commandcode.models = modelsObj

  const output = JSON.stringify(config, null, 2) + "\n"
  writeFileSync(GLOBAL_CONFIG, output, "utf-8")
  console.log(`  Updated ${GLOBAL_CONFIG}`)
}

async function main() {
  const args = process.argv.slice(2)
  const shouldUpdateGlobal = args.includes("--update-global")

  const { source, version } = await fetchLatestBundle()
  console.log(`Read CLI bundle v${version} (${(source.length / 1024).toFixed(0)} KB)`)

  console.log("Extracting string consts...")
  const consts = extractConsts(source)
  console.log(`  Found ${Object.keys(consts).length} consts: ${Object.keys(consts).slice(0, 15).join(", ")}...`)

  console.log("Extracting model catalog...")
  const models = extractModelCatalog(source, consts)
  const modelCount = Object.keys(models).length
  console.log(`  Found ${modelCount} models`)

  console.log("Extracting cost data...")
  const costs = extractCostData(source, consts)
  console.log(`  Found ${Object.values(costs).flat().length} legacy cost entries`)

  console.log("Extracting new cost data...")
  const newCosts = extractNewCostData(source, consts).map(normalizePricing)
  console.log(`  Found ${newCosts.length} new cost entries`)

  const costMap = buildCostMap(costs, newCosts)
  console.log(`  Total: ${costMap.size} cost entries`)

  const entries: ModelEntry[] = []

  for (const [, model] of Object.entries(models)) {
    if (model.hidden) {
      console.warn(`  Skipping hidden: ${model.id} (${model.name})`)
      continue
    }
    const entry = buildModelEntry(model, costMap)
    if (entry) {
      entries.push(entry)
    } else {
      console.warn(`  Skipping ${model.id}: no cost data`)
    }
  }

  for (const extra of HARDCODED_EXTRAS) {
    if (!entries.some((e) => e.id === extra.id)) {
      const entry = buildModelEntry(extra, costMap)
      if (entry) {
        console.log(`  Adding hardcoded extra: ${extra.id}`)
        entries.push(entry)
      }
    }
  }

  entries.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "premium" ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  console.log(`\nWriting ${MODELS_JSON} with ${entries.length} models...`)
  writeFileSync(MODELS_JSON, JSON.stringify(entries, null, 2) + "\n", "utf-8")

  const modelsObj = generateOpencodeModels(entries)

  if (shouldUpdateGlobal) {
    console.log("Updating global config...")
    updateGlobalConfig(modelsObj)
  }

  console.log("\nModel list:")
  for (const entry of entries) {
    const cost = `$${entry.cost.input}/$${entry.cost.output}`
    console.log(`  ${entry.tier.padEnd(12)} ${entry.id.padEnd(35)} ${entry.name.padEnd(25)} ${cost}`)
  }

  if (!shouldUpdateGlobal) {
    console.log(`\nRun with --update-global to update ${GLOBAL_CONFIG}`)
  }

  console.log("\nDone.")
}

main()
