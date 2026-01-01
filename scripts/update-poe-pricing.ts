#!/usr/bin/env bun

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const POE_API_URL = "https://api.poe.com/v1/models";
const BASE_DIR = path.join(process.cwd(), "providers", "poe", "models");

interface Pricing {
  prompt: string | null;
  completion: string | null;
  input_cache_read: string | null;
  input_cache_write: string | null;
  image?: string | null;
}

interface PoeModel {
  id: string;
  owned_by: string;
  pricing: Pricing | null;
  created?: number;
  supports_reasoning?: boolean | null;
  supports_tool_calls?: boolean | null;
  context_size?: number | null;
  context_length?: number | null;
  max_output_tokens?: number | null;
  architecture?: {
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
  } | null;
}

type TomlData = Record<string, unknown>;

function normalizeCostValue(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const num = Number(raw);
  if (Number.isNaN(num)) return null;
  const scaled = num * 1_000_000;
  // retain up to 6 decimal places to avoid truncating small values
  return Math.round(scaled * 1_000_000) / 1_000_000;
}

function normalizeTomlValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseToml(content: string): TomlData {
  const data: TomlData = {};
  let section: string | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      section = line.slice(1, -1);
      if (!data[section]) data[section] = {};
      continue;
    }
    const [key, ...rest] = line.split("=");
    if (!key || rest.length === 0) continue;
    const value = rest.join("=").trim();
    const normalized = normalizeTomlValue(value);
    const targetKey = key.trim();
    if (section) {
      const sectionData = data[section] as Record<string, unknown>;
      sectionData[targetKey] = normalized;
    } else {
      data[targetKey] = normalized;
    }
  }
  return data;
}

function formatCostValue(value: number | null): string | null {
  if (value === null) return null;
  const normalized = Math.round(value * 1_000_000) / 1_000_000;
  const formatted = normalized.toFixed(6).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return formatted;
}

function updateCostSection(content: string, pricing: Pricing | null): string {
  const newLines: string[] = [];
  const lines = content.split(/\r?\n/);
  let inCostSection = false;
  for (const line of lines) {
    if (line.trim().startsWith("[cost]")) {
      inCostSection = true;
      newLines.push("[cost]");
      const costLines: string[] = [];
      const input = formatCostValue(normalizeCostValue(pricing?.prompt ?? null));
      const output = formatCostValue(normalizeCostValue(pricing?.completion ?? null));
      const cacheRead = formatCostValue(normalizeCostValue(pricing?.input_cache_read ?? null));
      const cacheWrite = formatCostValue(normalizeCostValue(pricing?.input_cache_write ?? null));
      const image = formatCostValue(normalizeCostValue(pricing?.image ?? null));

      if (input !== null) costLines.push(`input = ${input}`);
      if (output !== null) costLines.push(`output = ${output}`);
      if (cacheRead !== null) costLines.push(`cache_read = ${cacheRead}`);
      if (cacheWrite !== null) costLines.push(`cache_write = ${cacheWrite}`);
      if (image !== null) costLines.push(`image = ${image}`);
      newLines.push(...costLines);
      continue;
    }
    if (inCostSection) {
      if (line.startsWith("[")) {
        inCostSection = false;
        if (newLines.length > 0 && newLines[newLines.length - 1] !== "") {
          newLines.push("");
        }
        newLines.push(line);
      }
      continue;
    }
    newLines.push(line);
  }
  if (!content.includes("[cost]")) {
    const costLines: string[] = [];
    const input = formatCostValue(normalizeCostValue(pricing?.prompt ?? null));
    const output = formatCostValue(normalizeCostValue(pricing?.completion ?? null));
    const cacheRead = formatCostValue(normalizeCostValue(pricing?.input_cache_read ?? null));
    const cacheWrite = formatCostValue(normalizeCostValue(pricing?.input_cache_write ?? null));
    const image = formatCostValue(normalizeCostValue(pricing?.image ?? null));

    if (input !== null || output !== null || cacheRead !== null || cacheWrite !== null || image !== null) {
      const insertIndex = newLines.findIndex((line) => line.trim().startsWith("[limit]"));
      const block = ["[cost]"];
      if (input !== null) block.push(`input = ${input}`);
      if (output !== null) block.push(`output = ${output}`);
      if (cacheRead !== null) block.push(`cache_read = ${cacheRead}`);
      if (cacheWrite !== null) block.push(`cache_write = ${cacheWrite}`);
      if (image !== null) block.push(`image = ${image}`);
      if (insertIndex === -1) {
        if (newLines.length > 0 && newLines[newLines.length - 1] !== "") {
          newLines.push("");
        }
        newLines.push(...block, "");
      } else {
        newLines.splice(insertIndex, 0, ...block, "");
      }
    }
  }
  return newLines.join("\n");
}

function updateLimitSection(content: string, contextValue: string | null, outputValue: string | null): string {
  const lines = content.split(/\r?\n/);
  const newLines: string[] = [];
  let i = 0;
  let replaced = false;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("[limit]")) {
      replaced = true;
      const limitLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith("[")) {
        limitLines.push(lines[j]);
        j += 1;
      }

      const existingContext = limitLines.find((l) => l.trim().startsWith("context =")) ?? "context = 0";
      const existingOutput = limitLines.find((l) => l.trim().startsWith("output =")) ?? "output = 0";

      const contextLine = contextValue !== null ? `context = ${contextValue}` : existingContext;
      const outputLine = outputValue !== null ? `output = ${outputValue}` : existingOutput;

      newLines.push("[limit]");
      newLines.push(contextLine);
      newLines.push(outputLine);
      newLines.push("");

      i = j;
      continue;
    }

    newLines.push(line);
    i += 1;
  }

  if (!replaced) {
    const contextLine = contextValue !== null ? `context = ${contextValue}` : "context = 0";
    const outputLine = outputValue !== null ? `output = ${outputValue}` : "output = 0";
    if (newLines.length > 0 && newLines[newLines.length - 1] !== "") {
      newLines.push("");
    }
    newLines.push("[limit]");
    newLines.push(contextLine);
    newLines.push(outputLine);
    newLines.push("");
  }

  return newLines.join("\n");
}

async function fetchPoeModels(): Promise<PoeModel[]> {
  const headers: Record<string, string> = {};
  const apiKey = process.env.POE_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(POE_API_URL, {
    headers,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Poe models: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return data.data as PoeModel[];
}

function ownerToDirectory(owner: string): string {
  const map: Record<string, string> = {
    "OpenAI": "openai",
    "Anthropic": "anthropic",
    "Google": "google",
    "XAI": "xai",
    "Together AI": "togetherai",
    "TwelveLabsAI": "twelvelabs",
    "Novita AI": "novita",
    "Meta": "facebook",
    "Bytedance": "bytedance",
    "Cartesia AI": "cartesia",
    "CerebrasAI": "cerebras",
    "Cohere": "cohere",
    "DeepInfra": "deepinfra",
    "ElevenLabs": "elevenlabs",
    "Empirio Labs AI": "empiriolabs",
    "Fireworks AI": "fireworks-ai",
    "GPT Researcher": "gptresearcher",
    "Hyperbolic": "hyperbolic",
    "IdeogramAI": "ideogramai",
    "Inception Labs": "inception",
    "Leonardo Ai": "leonardo-ai",
    "LumaLabs": "lumalabs",
    "RunwayML": "runwayml",
    "StabilityAI": "stabilityai",
    "TopazLabs-Co": "topazlabs-co",
    "TryTako": "trytako",
    "Unreal Speech": "unrealspeech",
    "OpenTools": "opentools",
    "Minimax": "minimax",
    "Mistral": "mistral",
    "fal": "fal",
  };
  return map[owner] ?? owner.toLowerCase().replace(/\s+/g, "");
}

function formatDate(ms: number | null | undefined): string {
  if (!ms && ms !== 0) return "null";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "null";
  return date.toISOString().split("T")[0];
}

function formatBool(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return "null";
  return value ? "true" : "false";
}

function formatCost(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const num = Number(raw);
  if (Number.isNaN(num)) return null;
  const scaled = Math.round(num * 1_000_000 * 1_000_000) / 1_000_000;
  const text = scaled.toFixed(6).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return text === "" ? "0" : text;
}

function formatLimit(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    return value.toLocaleString("en-US").replace(/,/g, "_");
  } catch {
    return null;
  }
}

function formatModalities(mods: string[] | null | undefined): string {
  if (!mods || mods.length === 0) return "null";
  return `[${mods.map((m) => `"${m}"`).join(", ")}]`;
}

function updateModalitiesSection(content: string, inputValue: string, outputValue: string): string {
  const lines = content.split(/\r?\n/);
  const newLines: string[] = [];
  let i = 0;
  let replaced = false;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("[modalities]")) {
      replaced = true;
      newLines.push("[modalities]");
      newLines.push(`input = ${inputValue}`);
      newLines.push(`output = ${outputValue}`);
      newLines.push("");

      i += 1;
      while (i < lines.length && !lines[i].startsWith("[")) {
        i += 1;
      }
      continue;
    }

    newLines.push(line);
    i += 1;
  }

  if (!replaced) {
    if (newLines.length > 0 && newLines[newLines.length - 1] !== "") {
      newLines.push("");
    }
    newLines.push("[modalities]");
    newLines.push(`input = ${inputValue}`);
    newLines.push(`output = ${outputValue}`);
    newLines.push("");
  }

  return newLines.join("\n");
}

function buildTomlContent(model: PoeModel): string {
  const releaseDate = formatDate(model.created ?? null);
  const reasoning = formatBool(model.supports_reasoning ?? null);
  const toolCall = formatBool(model.supports_tool_calls ?? null);
  const pricing = model.pricing ?? {};

  const costEntries: string[] = [];
  const input = formatCost(pricing.prompt ?? null);
  const output = formatCost(pricing.completion ?? null);
  const cacheRead = formatCost(pricing.input_cache_read ?? null);
  const cacheWrite = formatCost(pricing.input_cache_write ?? null);
  const image = formatCost((pricing as any).image ?? null);

  if (input !== null || output !== null || cacheRead !== null || cacheWrite !== null || image !== null) {
    costEntries.push("[cost]");
    if (input !== null) costEntries.push(`input = ${input}`);
    if (output !== null) costEntries.push(`output = ${output}`);
    if (cacheRead !== null) costEntries.push(`cache_read = ${cacheRead}`);
    if (cacheWrite !== null) costEntries.push(`cache_write = ${cacheWrite}`);
    if (image !== null) costEntries.push(`image = ${image}`);
    costEntries.push("");
  }

  const limitContext = formatLimit(model.context_length ?? model.context_size ?? null);
  const limitOutput = formatLimit(model.max_output_tokens ?? null);

  const architecture = model.architecture ?? {};
  const inputMods = formatModalities(architecture.input_modalities ?? null);
  const outputMods = formatModalities(architecture.output_modalities ?? null);

  const lines: string[] = [];
  lines.push(`name = "${model.id}"`);
  lines.push(releaseDate === "null" ? "release_date = null" : `release_date = "${releaseDate}"`);
  lines.push(releaseDate === "null" ? "last_updated = null" : `last_updated = "${releaseDate}"`);
  lines.push("attachment = true");
  lines.push(`reasoning = ${reasoning}`);
  lines.push("temperature = false");
  lines.push("open_weights = false");
  lines.push(`tool_call = ${toolCall}`);
  lines.push("");
  if (costEntries.length > 0) {
    lines.push(...costEntries);
  }
  lines.push("[limit]");
  lines.push(`context = ${limitContext}`);
  lines.push(`output = ${limitOutput}`);
  lines.push("");
  lines.push("[modalities]");
  lines.push(`input = ${inputMods}`);
  lines.push(`output = ${outputMods}`);
  lines.push("");
  return lines.join("\n");
}

async function updatePricing() {
  const models = await fetchPoeModels();
  console.log(`Fetched ${models.length} models from Poe`);

  const apiMap = new Map<string, PoeModel>();
  for (const model of models) {
    if (model.owned_by === "Poe") continue;
    apiMap.set(model.id.toLowerCase(), model);
  }

  const existingFiles = new Map<string, string>();
  const directories = await readdir(BASE_DIR, { withFileTypes: true });
  for (const entry of directories) {
    if (!entry.isDirectory()) continue;
    const providerDir = path.join(BASE_DIR, entry.name);
    const files = await readdir(providerDir, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".toml")) continue;
      const filePath = path.join(providerDir, file.name);
      existingFiles.set(path.parse(file.name).name, filePath);
    }
  }

  // Update existing models and track which remain
  for (const [fileId, filePath] of existingFiles.entries()) {
    const model = apiMap.get(fileId.toLowerCase());
    if (!model) {
      await unlink(filePath);
      console.log(`Removed stale model file ${filePath}`);
      continue;
    }
    const fileContent = await readFile(filePath, "utf8");
    let updatedContent = updateCostSection(fileContent, model.pricing);
    const limitContext = formatLimit(model.context_length ?? model.context_size ?? null);
    const limitOutput = formatLimit(model.max_output_tokens ?? null);
    updatedContent = updateLimitSection(updatedContent, limitContext, limitOutput);
    const arch = model.architecture ?? {};
    const inputMods = formatModalities(arch.input_modalities ?? null);
    const outputMods = formatModalities(arch.output_modalities ?? null);
    updatedContent = updateModalitiesSection(updatedContent, inputMods, outputMods);
    if (updatedContent !== fileContent) {
      await writeFile(filePath, updatedContent, "utf8");
      console.log(`Updated ${filePath}`);
    }
    apiMap.delete(fileId.toLowerCase());
  }

  // Create missing models
  for (const model of apiMap.values()) {
    const dirName = ownerToDirectory(model.owned_by);
    const providerDir = path.join(BASE_DIR, dirName);
    await mkdir(providerDir, { recursive: true });
    const filePath = path.join(providerDir, `${model.id.toLowerCase()}.toml`);
    const content = buildTomlContent(model as any);
    await writeFile(filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
    console.log(`Created draft for ${filePath}`);
  }
}

await updatePricing();
