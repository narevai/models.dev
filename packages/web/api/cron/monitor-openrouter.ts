import { runMonitor, round6 } from '../../../monitor/index'

export const config = {
  maxDuration: 60,
}

export default async function handler(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    await runMonitor({
      name: 'OpenRouter',
      title: '🛰 OpenRouter Models Update',
      s3Key: 'openrouter/snapshot.json',
      async fetchModels() {
        const res = await fetch('https://openrouter.ai/api/v1/models')
        if (!res.ok) throw new Error(`OpenRouter API error: ${res.status}`)
        const data = await res.json() as { data: Array<{ id: string; pricing: { prompt: string; completion: string } }> }
        return data.data.map(m => ({
          id: m.id,
          price_prompt: round6(parseFloat(m.pricing.prompt) * 1_000_000),
          price_completion: round6(parseFloat(m.pricing.completion) * 1_000_000),
        }))
      },
    })
    return new Response('ok')
  } catch (err) {
    console.error(err)
    return new Response('error', { status: 500 })
  }
}