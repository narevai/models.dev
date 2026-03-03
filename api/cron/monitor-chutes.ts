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
      name: 'Chutes',
      title: '🛰 Chutes Models Update',
      s3Key: 'chutes/snapshot.json',
      async fetchModels() {
        const headers: Record<string, string> = {}
        if (process.env.CHUTES_API_KEY) headers['Authorization'] = `Bearer ${process.env.CHUTES_API_KEY}`

        const fetchRes = await fetch('https://llm.chutes.ai/v1/models', { headers })
        if (!fetchRes.ok) throw new Error(`Chutes API error: ${fetchRes.status}`)
        const data = await fetchRes.json() as { data: Array<{ id: string; pricing: { prompt: number; completion: number } }> }

        return data.data.map(m => ({
          id: m.id,
          price_prompt: round6(m.pricing.prompt),
          price_completion: round6(m.pricing.completion),
        }))
      },
    })
    return res.send('ok')
  } catch (err) {
    console.error(err)
    return res.status(500).send('error')
  }
}