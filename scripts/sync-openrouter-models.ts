/**
 * Generates and cleans up TOML files for models.dev based on the OpenRouter model catalog.
 * Files are written to providers/openrouter/models/{provider}/{model}.toml
 *
 * Usage:
 *   npx tsx scripts/sync-openrouter-models.ts             # all missing models
 *   npx tsx scripts/sync-openrouter-models.ts openai      # only openai provider
 *   npx tsx scripts/sync-openrouter-models.ts openai qwen # multiple providers
 *
 * Fields that require manual review after generation:
 *   - family        (optional, but recommended)
 *   - knowledge     (optional, model knowledge cutoff date)
 *   - open_weights  (defaults to false)
 *   - reasoning     (defaults to false)
 */

import { createInterface } from 'readline'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const OPENROUTER_API = 'https://openrouter.ai/api/v1/models'
const OUTPUT_DIR = join(process.cwd(), 'providers/openrouter/models')

interface OpenRouterModel {
  id: string
  name: string
  created: number
  context_length: number
  hugging_face_id?: string
  pricing: {
    prompt: string
    completion: string
    image?: string
    request?: string
    input_cache_read?: string
    input_cache_write?: string
  }
  top_provider?: {
    max_completion_tokens?: number
    is_moderated?: boolean
  }
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
  supported_parameters?: string[]
}

function unixToDate(ts: number): string {
  const d = new Date(ts * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function tomlValue(v: string | number | boolean | string[]): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return `"${v}"`
  if (Array.isArray(v)) return `[${v.map(x => `"${x}"`).join(', ')}]`
  return String(v)
}

function formatInt(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '_')
}

function formatPrice(pricePerToken: string): number {
  return parseFloat(pricePerToken) * 1_000_000
}

function buildToml(model: OpenRouterModel): string {
  const inputPrice = formatPrice(model.pricing.prompt)
  const outputPrice = formatPrice(model.pricing.completion)
  const cacheReadPrice = model.pricing.input_cache_read
    ? formatPrice(model.pricing.input_cache_read)
    : null
  const cacheWritePrice = model.pricing.input_cache_write
    ? formatPrice(model.pricing.input_cache_write)
    : null

  const inputModalities = model.architecture?.input_modalities ?? ['text']
  const outputModalities = model.architecture?.output_modalities ?? ['text']

  const normalizeModalities = (mods: string[]) =>
    mods
      .map(x => (x === 'file' ? 'pdf' : x))
      .filter((x): x is 'text' | 'image' | 'audio' | 'video' | 'pdf' =>
        ['text', 'image', 'audio', 'video', 'pdf'].includes(x),
      )

  const inputMods = normalizeModalities(inputModalities)
  const outputMods = normalizeModalities(outputModalities)

  const hasAttachment = inputMods.some(m => ['image', 'audio', 'video', 'pdf'].includes(m))
  const hasTools = model.supported_parameters?.includes('tools') ?? false
  const hasStructuredOutput =
    (model.supported_parameters?.includes('response_format') ||
      model.supported_parameters?.includes('structured_outputs')) ??
    false
  const hasReasoning = model.supported_parameters?.includes('reasoning') ?? false
  const isOpenWeights = !!model.hugging_face_id
  const releaseDate = model.created ? unixToDate(model.created) : '2024-01-01'

  const outputTokens = model.top_provider?.max_completion_tokens ?? model.context_length

  const priceStr = (p: number) =>
    p === 0 ? '0' : parseFloat(p.toFixed(6)).toString()

  const lines: string[] = []

  lines.push(`name = ${tomlValue(model.name)}`)
  lines.push(``)
  lines.push(`release_date = ${tomlValue(releaseDate)}`)
  lines.push(`last_updated = ${tomlValue(releaseDate)}`)
  lines.push(`attachment = ${hasAttachment}`)
  lines.push(`reasoning = ${hasReasoning}`)
  lines.push(`temperature = true`)
  lines.push(`tool_call = ${hasTools}`)
  if (hasStructuredOutput) {
    lines.push(`structured_output = true`)
  }
  lines.push(`open_weights = ${isOpenWeights}`)
  lines.push(``)
  lines.push(`[cost]`)
  lines.push(`input = ${priceStr(inputPrice)}`)
  lines.push(`output = ${priceStr(outputPrice)}`)
  if (cacheReadPrice !== null && cacheReadPrice > 0) {
    lines.push(`cache_read = ${priceStr(cacheReadPrice)}`)
  }
  if (cacheWritePrice !== null && cacheWritePrice > 0) {
    lines.push(`cache_write = ${priceStr(cacheWritePrice)}`)
  }
  lines.push(``)
  lines.push(`[limit]`)
  lines.push(`context = ${formatInt(model.context_length)}`)
  lines.push(`output = ${formatInt(outputTokens)}`)
  lines.push(``)
  lines.push(`[modalities]`)
  lines.push(`input = ${tomlValue(inputMods)}`)
  lines.push(`output = ${tomlValue(outputMods)}`)

  return lines.join('\n') + '\n'
}

function getLocalModels(): Map<string, string> {
  // Returns a map of openrouter model id -> absolute file path
  const result = new Map<string, string>()
  if (!existsSync(OUTPUT_DIR)) return result

  for (const entry of readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const providerDir = join(OUTPUT_DIR, entry.name)
    for (const file of readdirSync(providerDir)) {
      if (!file.endsWith('.toml')) continue
      const modelSlug = file.slice(0, -5)
      const id = `${entry.name}/${modelSlug}`
      result.set(id, join(providerDir, file))
    }
  }
  return result
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function main() {
  const filterProviders = process.argv.slice(2)

  // ── Step 1: Fetch OpenRouter catalog ────────────────────────────────────────
  console.log('Fetching OpenRouter models...')
  const orRes = await fetch(OPENROUTER_API)
  if (!orRes.ok) throw new Error(`OpenRouter API error: ${orRes.status}`)
  const orData = await orRes.json()
  const orModels: OpenRouterModel[] = orData.data

  const orModelIds = new Set(orModels.map(m => m.id))
  console.log(`OpenRouter catalog: ${orModelIds.size} models`)

  // ── Step 2: Scan local TOML files ───────────────────────────────────────────
  console.log('Scanning local TOML files...')
  const localModels = getLocalModels()
  console.log(`Local models: ${localModels.size}`)

  // ── Step 3: Generate missing TOML files ─────────────────────────────────────
  const missing = orModels.filter(m => {
    if (!m.id.includes('/')) return false
    if (localModels.has(m.id)) return false
    if (filterProviders.length > 0) {
      return filterProviders.includes(m.id.split('/')[0])
    }
    return true
  })

  console.log(`\n── Step 1/2: Generating TOML for ${missing.length} missing models ──`)
  if (filterProviders.length > 0) {
    console.log(`Provider filter: ${filterProviders.join(', ')}`)
  }

  let generated = 0
  let skipped = 0
  const generatedIds: string[] = []

  for (const model of missing) {
    const [providerSlug, ...rest] = model.id.split('/')
    const modelSlug = rest.join('/')

    if (!providerSlug || !modelSlug) {
      skipped++
      continue
    }

    const dir = join(OUTPUT_DIR, providerSlug)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    writeFileSync(join(dir, `${modelSlug}.toml`), buildToml(model), 'utf-8')
    console.log(`  + ${model.id}`)
    generatedIds.push(model.id)
    generated++
  }

  console.log(`\nGenerated: ${generated}, Skipped: ${skipped}`)

  if (generated > 0) {
    console.log(`\nFields that may need manual review:`)
    console.log(`  family       — model family slug (optional)`)
    console.log(`  knowledge    — knowledge cutoff date, e.g. "2024-10" (optional)`)
    console.log(`  open_weights — true if weights are public (default: false)`)
    console.log(`  reasoning    — true for reasoning/thinking models (default: false)`)

    const providers = [...new Set(generatedIds.map(id => id.split('/')[0]))]

    console.log(`\n${'─'.repeat(60)}`)
    console.log(`PR DESCRIPTION`)
    console.log(`${'─'.repeat(60)}`)
    console.log(`## Add missing ${providers.join(', ')} models from OpenRouter\n`)
    console.log(`Adds TOML configurations for ${generated} models available on OpenRouter that were missing from the registry:\n`)
    for (const id of generatedIds) {
      console.log(`- \`${id}\``)
    }
    console.log(`
Field mapping from OpenRouter API:
- \`name\` → name
- \`pricing.prompt\` × 1M → cost.input
- \`pricing.completion\` × 1M → cost.output
- \`pricing.input_cache_read\` × 1M → cost.cache_read
- \`pricing.input_cache_write\` × 1M → cost.cache_write
- \`context_length\` → limit.context
- \`top_provider.max_completion_tokens\` → limit.output
- \`architecture.input_modalities\` / \`output_modalities\` → modalities
- \`supported_parameters\` includes \`tools\` → tool_call
- \`supported_parameters\` includes \`response_format\`/\`structured_outputs\` → structured_output
- \`supported_parameters\` includes \`reasoning\` → reasoning
- \`hugging_face_id\` non-empty → open_weights

Source: https://openrouter.ai/api/v1/models`)
    console.log(`${'─'.repeat(60)}`)
  }

  // ── Step 4: Check for stale TOML files ──────────────────────────────────────
  console.log(`\n── Step 2/2: Checking for stale models no longer on OpenRouter ──`)

  const stale: Array<{ id: string; path: string }> = []
  for (const [id, filePath] of localModels) {
    if (!orModelIds.has(id)) {
      stale.push({ id, path: filePath })
    }
  }

  if (stale.length === 0) {
    console.log('All local models are still available on OpenRouter. Nothing to remove.')
    return
  }

  console.log(`\nFound ${stale.length} local model(s) no longer listed on OpenRouter:\n`)
  for (const { id } of stale) {
    console.log(`  - ${id}`)
  }

  const answer = await prompt(`\nRemove these ${stale.length} file(s)? [y/N] `)

  if (answer.toLowerCase() === 'y') {
    for (const { id, path } of stale) {
      rmSync(path)
      console.log(`  Removed: ${id}`)
    }
    console.log(`\nRemoved ${stale.length} stale model file(s).`)
  } else {
    console.log('Skipped. No files were removed.')
  }
}

main().catch(console.error)
