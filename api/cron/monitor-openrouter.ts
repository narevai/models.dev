import { runMonitor, round6 } from '../../packages/monitor/index.ts'

export const config = {
  maxDuration: 60,
}

export default async function handler(req: any, res: any) {
  const authHeader = req.headers['authorization']
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send('Unauthorized')
  }

  try {
    await runMonitor({
      name: 'OpenRouter',
      title: '🛰 OpenRouter Models Update',
      s3Key: 'openrouter/snapshot.json',
      async fetchModels() {
        const fetchRes = await fetch('https://openrouter.ai/api/v1/models')
        if (!fetchRes.ok) throw new Error(`OpenRouter API error: ${fetchRes.status}`)
        const data = await fetchRes.json() as { data: Array<{ id: string; pricing: { prompt: string; completion: string } }> }
        return data.data.map(m => ({
          id: m.id,
          price_prompt: round6(parseFloat(m.pricing.prompt) * 1_000_000),
          price_completion: round6(parseFloat(m.pricing.completion) * 1_000_000),
        }))
      },
    })
    return res.send('ok')
  } catch (err) {
    console.error(err)
    return res.status(500).send('error')
  }
}