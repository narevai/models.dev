/**
 * OpenRouter Models Monitor
 * Required env vars: SLACK_WEBHOOK_URL, S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 * Usage: bun run monitor:openrouter
 */

import { runMonitor, round6 } from './lib.ts'

runMonitor({
  name: 'OpenRouter',
  title: '🛰 OpenRouter Models Update',
  s3Key: 'openrouter/snapshot.json',
  async fetchModels() {
    const res = await fetch('https://openrouter.ai/api/v1/models')
    if (!res.ok) throw new Error(`OpenRouter API error: ${res.status} ${res.statusText}`)
    const data = await res.json() as { data: Array<{ id: string; pricing: { prompt: string; completion: string } }> }

    return data.data.map(m => ({
      id: m.id,
      price_prompt: round6(parseFloat(m.pricing.prompt) * 1_000_000),
      price_completion: round6(parseFloat(m.pricing.completion) * 1_000_000),
    }))
  },
}).catch(err => {
  console.error(err)
  process.exit(1)
})
