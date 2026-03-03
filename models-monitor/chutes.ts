/**
 * Chutes Models Monitor
 * Required env vars: SLACK_WEBHOOK_URL, S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 * Optional: CHUTES_API_KEY
 * Usage: bun run monitor:chutes
 */

import { runMonitor, round6 } from './lib.ts'

runMonitor({
  name: 'Chutes',
  title: '🛰 Chutes Models Update',
  s3Key: 'chutes/snapshot.json',
  async fetchModels() {
    const headers: Record<string, string> = {}
    if (process.env.CHUTES_API_KEY) headers['Authorization'] = `Bearer ${process.env.CHUTES_API_KEY}`

    const res = await fetch('https://llm.chutes.ai/v1/models', { headers })
    if (!res.ok) throw new Error(`Chutes API error: ${res.status} ${res.statusText}`)
    const data = await res.json() as { data: Array<{ id: string; pricing: { prompt: number; completion: number } }> }

    // Chutes returns prices already in USD/1M tokens
    return data.data.map(m => ({
      id: m.id,
      price_prompt: round6(m.pricing.prompt),
      price_completion: round6(m.pricing.completion),
    }))
  },
}).catch(err => {
  console.error(err)
  process.exit(1)
})
