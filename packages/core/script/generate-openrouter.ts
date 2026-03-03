#!/usr/bin/env bun

/**
 * Generates and updates OpenRouter model TOML files.
 * Creates new files for missing models, updates existing ones from API data.
 * Does NOT delete files — models absent from the API may be temporarily unavailable.
 *
 * Flags:
 *   --dry-run:  Preview changes without writing files
 *   --new-only: Only create new models, skip updating existing ones
 *   [provider]: Filter to specific provider(s), e.g. "openai qwen"
 *
 * Usage:
 *   bun packages/core/script/generate-openrouter.ts
 *   bun packages/core/script/generate-openrouter.ts --dry-run
 *   bun packages/core/script/generate-openrouter.ts openai --dry-run
 */

import { z } from "zod";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const OPENROUTER_API = "https://openrouter.ai/api/v1/models";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const Pricing = z.object({
  prompt: z.string(),
  completion: z.string(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
}).passthrough();

const OpenRouterModel = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number().nullish(),
  context_length: z.number(),
  pricing: Pricing,
  hugging_face_id: z.string().nullish(),
  top_provider: z.object({
    max_completion_tokens: z.number().nullish(),
  }).passthrough().nullish(),
  architecture: z.object({
    input_modalities: z.array(z.string()).nullish(),
    output_modalities: z.array(z.string()).nullish(),
  }).passthrough().nullish(),
  supported_parameters: z.array(z.string()).nullish(),
}).passthrough();

const OpenRouterResponse = z.object({
  data: z.array(OpenRouterModel),
}).passthrough();

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExistingModel {
  id?: string;
  name?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  open_weights?: boolean;
  knowledge?: string;
  status?: string;
  release_date?: string;
  last_updated?: string;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
}

interface MergedModel {
  id?: string;
  name: string;
  family?: string;
  attachment: boolean;
  reasoning: boolean;
  temperature: boolean;
  tool_call: boolean;
  structured_output?: boolean;
  open_weights: boolean;
  knowledge?: string;
  status?: string;
  release_date: string;
  last_updated: string;
  cost: { input: number; output: number; cache_read?: number; cache_write?: number };
  limit: { context: number; output: number };
  modalities: { input: string[]; output: string[] };
}

interface Change {
  field: string;
  oldValue: string;
  newValue: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function unixToDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatInt(n: number): string {
  if (n >= 1000) return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  return n.toString();
}

function priceStr(p: number): string {
  return p === 0 ? "0" : parseFloat(p.toFixed(6)).toString();
}

type Modality = "text" | "image" | "audio" | "video" | "pdf";

function normalizeModalities(mods: string[]): Modality[] {
  return mods
    .map((x) => (x === "file" ? "pdf" : x))
    .filter((x): x is Modality =>
      ["text", "image", "audio", "video", "pdf"].includes(x),
    );
}

// ── Load existing TOML ────────────────────────────────────────────────────────

async function loadExistingModel(filePath: string): Promise<ExistingModel | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const toml = await import(filePath, { with: { type: "toml" } }).then(
      (m) => m.default,
    );
    return toml as ExistingModel;
  } catch (e) {
    console.warn(`Warning: Failed to parse ${filePath}:`, e);
    return null;
  }
}

// ── Merge ─────────────────────────────────────────────────────────────────────

function mergeModel(
  api: z.infer<typeof OpenRouterModel>,
  existing: ExistingModel | null,
): MergedModel {
  const inputMods = normalizeModalities(api.architecture?.input_modalities ?? ["text"]);
  const outputMods = normalizeModalities(api.architecture?.output_modalities ?? ["text"]);

  const hasAttachment = inputMods.some((m) => ["image", "audio", "video", "pdf"].includes(m));
  const hasTools = api.supported_parameters?.includes("tools") ?? false;
  const hasStructuredOutput =
    (api.supported_parameters?.includes("response_format") ||
      api.supported_parameters?.includes("structured_outputs")) ??
    false;
  const hasReasoning = api.supported_parameters?.includes("reasoning") ?? false;
  const isOpenWeights = !!api.hugging_face_id;

  const releaseDate = api.created ? unixToDate(api.created) : getTodayDate();
  const outputTokens = api.top_provider?.max_completion_tokens ?? api.context_length;

  const inputPrice = parseFloat(api.pricing.prompt) * 1_000_000;
  const outputPrice = parseFloat(api.pricing.completion) * 1_000_000;
  const cacheReadPrice = api.pricing.input_cache_read
    ? parseFloat(api.pricing.input_cache_read) * 1_000_000
    : undefined;
  const cacheWritePrice = api.pricing.input_cache_write
    ? parseFloat(api.pricing.input_cache_write) * 1_000_000
    : undefined;

  return {
    // Preserve id if it was in the existing file
    ...(existing?.id && { id: existing.id }),
    // Preserve manually curated name, fall back to API
    name: existing?.name ?? api.name,
    // Only from existing — API has no family concept
    ...(existing?.family && { family: existing.family }),
    // From API (source of truth for capabilities)
    attachment: hasAttachment,
    reasoning: hasReasoning,
    temperature: true,
    tool_call: hasTools,
    // Preserve manual structured_output override; infer from API otherwise
    ...(existing?.structured_output !== undefined
      ? { structured_output: existing.structured_output }
      : hasStructuredOutput
        ? { structured_output: true }
        : {}),
    // Preserve manual open_weights override; use API signal otherwise
    open_weights: existing?.open_weights ?? isOpenWeights,
    // Only from existing — API has no knowledge cutoff
    ...(existing?.knowledge && { knowledge: existing.knowledge }),
    ...(existing?.status && { status: existing.status }),
    // Preserve manually set release_date; fall back to API created timestamp
    release_date: existing?.release_date ?? releaseDate,
    last_updated: getTodayDate(),
    // Always from API
    cost: {
      input: inputPrice,
      output: outputPrice,
      ...(cacheReadPrice !== undefined && cacheReadPrice > 0 ? { cache_read: cacheReadPrice } : {}),
      ...(cacheWritePrice !== undefined && cacheWritePrice > 0 ? { cache_write: cacheWritePrice } : {}),
    },
    limit: {
      context: api.context_length,
      output: outputTokens,
    },
    modalities: {
      input: inputMods,
      output: outputMods,
    },
  };
}

// ── Format TOML ───────────────────────────────────────────────────────────────

function formatToml(model: MergedModel): string {
  const lines: string[] = [];

  if (model.id) lines.push(`id = "${model.id}"`);
  lines.push(`name = "${model.name.replace(/"/g, '\\"')}"`);
  if (model.family) lines.push(`family = "${model.family}"`);
  lines.push(``);
  lines.push(`release_date = "${model.release_date}"`);
  lines.push(`last_updated = "${model.last_updated}"`);
  lines.push(`attachment = ${model.attachment}`);
  lines.push(`reasoning = ${model.reasoning}`);
  lines.push(`temperature = ${model.temperature}`);
  lines.push(`tool_call = ${model.tool_call}`);
  if (model.structured_output !== undefined) {
    lines.push(`structured_output = ${model.structured_output}`);
  }
  lines.push(`open_weights = ${model.open_weights}`);
  if (model.knowledge) lines.push(`knowledge = "${model.knowledge}"`);
  if (model.status) lines.push(`status = "${model.status}"`);

  lines.push(``);
  lines.push(`[cost]`);
  lines.push(`input = ${priceStr(model.cost.input)}`);
  lines.push(`output = ${priceStr(model.cost.output)}`);
  if (model.cost.cache_read !== undefined) lines.push(`cache_read = ${priceStr(model.cost.cache_read)}`);
  if (model.cost.cache_write !== undefined) lines.push(`cache_write = ${priceStr(model.cost.cache_write)}`);

  lines.push(``);
  lines.push(`[limit]`);
  lines.push(`context = ${formatInt(model.limit.context)}`);
  lines.push(`output = ${formatInt(model.limit.output)}`);

  lines.push(``);
  lines.push(`[modalities]`);
  lines.push(`input = [${model.modalities.input.map((m) => `"${m}"`).join(", ")}]`);
  lines.push(`output = [${model.modalities.output.map((m) => `"${m}"`).join(", ")}]`);

  return lines.join("\n") + "\n";
}

// ── Detect changes ────────────────────────────────────────────────────────────

function detectChanges(existing: ExistingModel, merged: MergedModel): Change[] {
  const changes: Change[] = [];
  const EPSILON = 0.001;

  const fmt = (val: unknown): string => {
    if (typeof val === "number") return String(val);
    if (Array.isArray(val)) return `[${val.join(", ")}]`;
    if (val === undefined) return "(none)";
    return String(val);
  };

  const isMaterialPriceDiff = (a: unknown, b: unknown): boolean => {
    if (a === 0 && b === undefined) return false;
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) > EPSILON;
    return JSON.stringify(a) !== JSON.stringify(b);
  };

  const compare = (field: string, oldVal: unknown, newVal: unknown, isPrice = false) => {
    const isDiff = isPrice
      ? isMaterialPriceDiff(oldVal, newVal)
      : JSON.stringify(oldVal) !== JSON.stringify(newVal);
    if (isDiff) changes.push({ field, oldValue: fmt(oldVal), newValue: fmt(newVal) });
  };

  compare("name", existing.name, merged.name);
  compare("attachment", existing.attachment, merged.attachment);
  compare("reasoning", existing.reasoning, merged.reasoning);
  compare("tool_call", existing.tool_call, merged.tool_call);
  compare("structured_output", existing.structured_output, merged.structured_output);
  compare("open_weights", existing.open_weights, merged.open_weights);
  compare("cost.input", existing.cost?.input, merged.cost.input, true);
  compare("cost.output", existing.cost?.output, merged.cost.output, true);
  compare("cost.cache_read", existing.cost?.cache_read, merged.cost.cache_read, true);
  compare("cost.cache_write", existing.cost?.cache_write, merged.cost.cache_write, true);
  compare("limit.context", existing.limit?.context, merged.limit.context);
  compare("limit.output", existing.limit?.output, merged.limit.output);
  compare("modalities.input", existing.modalities?.input, merged.modalities.input);
  compare("modalities.output", existing.modalities?.output, merged.modalities.output);

  return changes;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const newOnly = args.includes("--new-only");
  const filterProviders = args.filter((a) => !a.startsWith("--"));

  const modelsDir = path.join(
    import.meta.dirname, "..", "..", "..", "providers", "openrouter", "models",
  );

  const prefix = [dryRun && "[DRY RUN]", newOnly && "[NEW ONLY]"].filter(Boolean).join(" ");
  console.log(`${prefix ? prefix + " " : ""}Fetching OpenRouter models...`);

  const res = await fetch(OPENROUTER_API);
  if (!res.ok) {
    console.error(`Failed to fetch API: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const parsed = OpenRouterResponse.safeParse(await res.json());
  if (!parsed.success) {
    console.error("Invalid API response:", parsed.error.errors);
    process.exit(1);
  }

  const apiModels = parsed.data.data.filter((m) => m.id.includes("/"));
  const apiModelPaths = new Set<string>();

  if (filterProviders.length > 0) console.log(`Provider filter: ${filterProviders.join(", ")}`);
  console.log(`Fetched ${apiModels.length} models from OpenRouter API\n`);

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const apiModel of apiModels) {
    const [providerSlug, ...rest] = apiModel.id.split("/");
    const modelSlug = rest.join("/");
    if (!providerSlug || !modelSlug) continue;

    if (filterProviders.length > 0 && !filterProviders.includes(providerSlug)) continue;

    const relativePath = `${providerSlug}/${modelSlug}.toml`;
    const filePath = path.join(modelsDir, relativePath);
    apiModelPaths.add(relativePath);

    const existing = await loadExistingModel(filePath);
    const merged = mergeModel(apiModel, existing);
    const tomlContent = formatToml(merged);

    if (existing === null) {
      created++;
      if (dryRun) {
        console.log(`[DRY RUN] Would create: ${relativePath}`);
        console.log(`  name = "${merged.name}"`);
        console.log();
      } else {
        await mkdir(path.dirname(filePath), { recursive: true });
        await Bun.write(filePath, tomlContent);
        console.log(`Created: ${relativePath}`);
      }
    } else {
      if (newOnly) { unchanged++; continue; }

      const changes = detectChanges(existing, merged);

      if (changes.length > 0) {
        updated++;
        if (dryRun) {
          console.log(`[DRY RUN] Would update: ${relativePath}`);
        } else {
          await Bun.write(filePath, tomlContent);
          console.log(`Updated: ${relativePath}`);
        }
        for (const c of changes) {
          console.log(`  ${c.field}: ${c.oldValue} → ${c.newValue}`);
        }
        console.log();
      } else {
        unchanged++;
      }
    }
  }

  // Report orphaned files but never delete them
  let orphaned = 0;
  for await (const file of new Bun.Glob("**/*.toml").scan({ cwd: modelsDir, absolute: false })) {
    if (!apiModelPaths.has(file)) {
      if (orphaned === 0) console.log();
      console.log(`Note: ${file} not in OpenRouter API (kept)`);
      orphaned++;
    }
  }

  console.log();
  if (dryRun) {
    console.log(`Summary: ${created} would be created, ${updated} would be updated, ${unchanged} unchanged, ${orphaned} not in API (kept)`);
  } else {
    console.log(`Summary: ${created} created, ${updated} updated, ${unchanged} unchanged, ${orphaned} not in API (kept)`);
  }
}

await main();
