export interface ModelEntry {
  id: string
  price_prompt: number     // per 1M input tokens, USD
  price_completion: number // per 1M output tokens, USD
}

export interface Snapshot {
  timestamp: string
  models: ModelEntry[]
}

export interface MonitorOptions {
  name: string
  title: string
  s3Key: string
  fetchModels: () => Promise<ModelEntry[]>
}

export interface PriceChange {
  id: string
  old_prompt: number
  new_prompt: number
  old_completion: number
  new_completion: number
}
