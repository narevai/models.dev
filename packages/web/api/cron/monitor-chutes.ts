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
      name: 'Chutes',
      title: '🛰 Chutes Models Update',
      s3Key: 'chutes/snapshot.json',
      async fetchModels() {
        const headers: Record<string, string> = {}
        if (process.env.CHUTES_API_KEY) headers['Authorization'] = `Bearer ${process.env.CHUTES_API_KEY}`

        const res = await fetch('https://llm.chutes.ai/v1/models', { headers })
        if (!res.ok) throw new Error(`Chutes API error: ${res.status}`)
        const data = await res.json() as { data: Array<{ id: string; pricing: { prompt: number; completion: number } }> }

        return data.data.map(m => ({
          id: m.id,
          price_prompt: round6(m.pricing.prompt),
          price_completion: round6(m.pricing.completion),
        }))
      },
    })
    return new Response('ok')
  } catch (err) {
    console.error(err)
    return new Response('error', { status: 500 })
  }
}