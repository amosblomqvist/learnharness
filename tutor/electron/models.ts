// One menu, many brains. A model id is "<provider>:<model>".
import { createAnthropic } from "@ai-sdk/anthropic"
import { createXai } from "@ai-sdk/xai"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"
import { getKey, getSettings } from "./settings"
import { grokModels } from "./grok"
import fs from "node:fs"

export type Provider = "claude-plan" | "grok-plan" | "anthropic" | "xai" | "openai" | "ollama"

export type ModelOption = { id: string; label: string; provider: Provider; group: string; ready: boolean; note?: string }

const CLAUDE = [
  ["claude-opus-5-5", "Opus 5.5 · deepest"],
  ["claude-fable-5-1", "Fable 5.1"],
  ["claude-sonnet-5-5", "Sonnet 5.5 · everyday"],
  ["claude-haiku-4-5-20251001", "Haiku 4.5 · fastest"]
] as const

const GROK = [
  ["grok-4.7", "Grok 4.7"],
  ["grok-4.3", "Grok 4.3 · cheaper, 1M context"],
  ["grok-build-0.1", "Grok Build 0.1 · cheapest"]
] as const

export function splitId(id: string): { provider: Provider; model: string } {
  const i = id.indexOf(":")
  return { provider: id.slice(0, i) as Provider, model: id.slice(i + 1) }
}

async function ollamaModels(url: string): Promise<string[]> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1500) })
    const data = (await res.json()) as { models?: { name: string }[] }
    return (data.models ?? []).map((m) => m.name)
  } catch {
    return []
  }
}

async function openaiModels(key: string): Promise<string[]> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000) })
    const data = (await res.json()) as { data?: { id: string }[] }
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id) => /^(gpt-|o\d)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding|instruct)/.test(id))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

export async function listModels(): Promise<ModelOption[]> {
  const s = getSettings()
  const out: ModelOption[] = []
  for (const [m, label] of CLAUDE) out.push({ id: `claude-plan:${m}`, label, provider: "claude-plan", group: "Claude · my plan (Claude Code login)", ready: true })
  // Grok Build (SuperGrok / X Premium+ login), if it's installed.
  if (fs.existsSync(s.grokPath)) {
    const { list, def } = await grokModels(s.grokPath)
    for (const m of list.length ? list : ["grok-4.7", "grok-4.6"])
      out.push({ id: `grok-plan:${m}`, label: `${m.replace(/^grok-/, "Grok ")}${m === def ? " · default" : m.includes("fast") ? " · fast" : ""}`, provider: "grok-plan", group: "Grok · my subscription (Grok Build login)", ready: true })
  }
  const hasAnthropic = !!getKey("anthropic")
  for (const [m, label] of CLAUDE) out.push({ id: `anthropic:${m}`, label, provider: "anthropic", group: "Claude · API key", ready: hasAnthropic, note: hasAnthropic ? undefined : "add key in settings" })
  const hasXai = !!getKey("xai")
  for (const [m, label] of GROK) out.push({ id: `xai:${m}`, label, provider: "xai", group: "Grok · API key", ready: hasXai, note: hasXai ? undefined : "add key in settings" })
  const oaKey = getKey("openai")
  if (oaKey) for (const m of (await openaiModels(oaKey)).slice(0, 12)) out.push({ id: `openai:${m}`, label: m, provider: "openai", group: "OpenAI · API key", ready: true })
  const local = await ollamaModels(s.ollamaUrl)
  for (const m of local) out.push({ id: `ollama:${m}`, label: m, provider: "ollama", group: "Local · Ollama", ready: true })
  if (!local.length) out.push({ id: "ollama:", label: "Ollama not running / no models", provider: "ollama", group: "Local · Ollama", ready: false })
  return out
}

// For every provider except claude-plan (which goes through the Agent SDK).
export function languageModel(id: string): LanguageModel {
  const { provider, model } = splitId(id)
  const need = (k: "anthropic" | "xai" | "openai") => {
    const v = getKey(k)
    if (!v) throw new Error(`No ${{ anthropic: "Anthropic", xai: "xAI (Grok)", openai: "OpenAI" }[k]} API key yet. Add it in Settings (gear icon).`)
    return v
  }
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: need("anthropic") })(model)
    case "xai":
      return createXai({ apiKey: need("xai") })(model)
    case "openai":
      return createOpenAI({ apiKey: need("openai") })(model)
    case "ollama":
      if (!model) throw new Error("No local model. Install one with: ollama pull qwen3")
      return createOpenAICompatible({ name: "ollama", baseURL: `${getSettings().ollamaUrl}/v1` })(model)
    default:
      throw new Error(`Unknown provider for ${id}`)
  }
}
