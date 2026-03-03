import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModelEntry {
  id: string
  price_prompt: number     // per 1M input tokens, USD
  price_completion: number // per 1M output tokens, USD
}

export interface Snapshot {
  timestamp: string
  models: ModelEntry[]
}

type SlackBlock = Record<string, unknown>

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Round to 6 decimal places to avoid float noise in comparisons */
export function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

function formatPrice(p: number): string {
  if (p === 0) return '$0'
  return `$${p.toFixed(2)}`
}

function priceArrow(oldVal: number, newVal: number): string {
  if (newVal > oldVal) return '↑'
  if (newVal < oldVal) return '↓'
  return '→'
}

function pctChange(oldVal: number, newVal: number): string {
  if (oldVal === 0) return ''
  const pct = ((newVal - oldVal) / oldVal) * 100
  const sign = pct > 0 ? '+' : ''
  return ` _(${sign}${Math.round(pct)}%)_`
}

function truncateList(lines: string[], maxItems = 20, sep = '\n'): string {
  if (lines.length <= maxItems) return lines.join(sep)
  return lines.slice(0, maxItems).join(sep) + `${sep}_…and ${lines.length - maxItems} more_`
}

// ── S3 ────────────────────────────────────────────────────────────────────────

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1' })

export async function loadSnapshot(bucket: string, key: string): Promise<Snapshot | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const body = await res.Body!.transformToString()
    return JSON.parse(body) as Snapshot
  } catch (e: any) {
    if (e.name === 'NoSuchKey' || e.Code === 'NoSuchKey') return null
    throw e
  }
}

export async function saveSnapshot(bucket: string, key: string, models: ModelEntry[]): Promise<void> {
  const snapshot: Snapshot = { timestamp: new Date().toISOString(), models }
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(snapshot, null, 2),
      ContentType: 'application/json',
    }),
  )
}

// ── Slack ─────────────────────────────────────────────────────────────────────

export async function sendSlack(fallbackText: string, blocks: SlackBlock[]): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL ?? ''
  if (!webhookUrl) {
    console.log('[Slack] No SLACK_WEBHOOK_URL set — skipping notification')
    console.log('[Slack] Message would be:', fallbackText)
    return
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: fallbackText, blocks }),
  })

  if (!res.ok) {
    console.error(`[Slack] Webhook error: ${res.status} ${await res.text()}`)
  }
}

type PriceChange = {
  id: string
  old_prompt: number
  new_prompt: number
  old_completion: number
  new_completion: number
}

export function buildSlackBlocks(
  title: string,
  added: ModelEntry[],
  removed: ModelEntry[],
  priceChanges: PriceChange[],
  previousTimestamp: string,
): SlackBlock[] {
  const blocks: SlackBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
    { type: 'divider' },
  ]

  if (added.length > 0) {
    const lines = added.map(
      m => `• \`${m.id}\`\n  *in:* ${formatPrice(m.price_prompt)}/1M  *out:* ${formatPrice(m.price_completion)}/1M`,
    )
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `✅ *New models (${added.length})*\n\n${truncateList(lines, 20, '\n\n')}` },
    })
  }

  if (removed.length > 0) {
    const lines = removed.map(m => `• \`${m.id}\``)
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `❌ *Removed models (${removed.length})*\n\n${truncateList(lines, 20, '\n\n')}` },
    })
  }

  if (priceChanges.length > 0) {
    const lines = priceChanges.map(c => {
      const parts: string[] = []
      if (c.old_prompt !== c.new_prompt) {
        parts.push(`*in:* ${formatPrice(c.old_prompt)} ${priceArrow(c.old_prompt, c.new_prompt)} ${formatPrice(c.new_prompt)}/1M${pctChange(c.old_prompt, c.new_prompt)}`)
      }
      if (c.old_completion !== c.new_completion) {
        parts.push(`*out:* ${formatPrice(c.old_completion)} ${priceArrow(c.old_completion, c.new_completion)} ${formatPrice(c.new_completion)}/1M${pctChange(c.old_completion, c.new_completion)}`)
      }
      return `• \`${c.id}\`\n  ${parts.join('  ')}`
    })
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `💰 *Price changes (${priceChanges.length})*\n\n${truncateList(lines, 20, '\n\n')}` },
    })
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Checked at ${new Date().toISOString()} | Previous snapshot: ${previousTimestamp}` }],
  })

  return blocks
}

// ── Monitor runner ────────────────────────────────────────────────────────────

export interface MonitorOptions {
  name: string    // e.g. "OpenRouter"
  title: string   // Slack header, e.g. "🛰 OpenRouter Models Update"
  s3Key: string   // e.g. "openrouter/snapshot.json"
  fetchModels: () => Promise<ModelEntry[]>
}

export async function runMonitor({ name, title, s3Key, fetchModels }: MonitorOptions): Promise<void> {
  const bucket = process.env.S3_BUCKET ?? 'models-monitor'

  console.log(`Fetching ${name} models...`)
  const current = await fetchModels()
  console.log(`  ${current.length} models fetched`)

  console.log(`Loading snapshot from s3://${bucket}/${s3Key}...`)
  const previous = await loadSnapshot(bucket, s3Key)

  if (!previous) {
    console.log('No previous snapshot found — saving initial snapshot.')
    await saveSnapshot(bucket, s3Key, current)
    await sendSlack(
      `${name} Monitor initialized — tracking ${current.length} models.`,
      [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*🛰 ${name} Monitor initialized*\nTracking *${current.length} models*. Future runs will report changes.\n\`s3://${bucket}/${s3Key}\``,
        },
      }],
    )
    console.log('Done.')
    return
  }

  console.log(`  Previous snapshot: ${previous.models.length} models (${previous.timestamp})`)

  const prevMap = new Map(previous.models.map(m => [m.id, m]))

  const added = current.filter(m => !prevMap.has(m.id))
  const removed = previous.models.filter(m => !new Map(current.map(m => [m.id, m])).has(m.id))

  const priceChanges = current
    .filter(m => {
      const prev = prevMap.get(m.id)
      if (!prev) return false
      return prev.price_prompt !== m.price_prompt || prev.price_completion !== m.price_completion
    })
    .map(m => {
      const prev = prevMap.get(m.id)!
      return {
        id: m.id,
        old_prompt: prev.price_prompt,
        new_prompt: m.price_prompt,
        old_completion: prev.price_completion,
        new_completion: m.price_completion,
      }
    })

  console.log(`  Added: ${added.length} | Removed: ${removed.length} | Price changes: ${priceChanges.length}`)

  if (added.length === 0 && removed.length === 0 && priceChanges.length === 0) {
    console.log('No changes detected.')
    await saveSnapshot(bucket, s3Key, current)
    return
  }

  const summaryParts = [
    added.length > 0 ? `${added.length} new` : null,
    removed.length > 0 ? `${removed.length} removed` : null,
    priceChanges.length > 0 ? `${priceChanges.length} price change(s)` : null,
  ].filter(Boolean)

  await sendSlack(
    `${name} update: ${summaryParts.join(', ')}`,
    buildSlackBlocks(title, added, removed, priceChanges, previous.timestamp),
  )
  await saveSnapshot(bucket, s3Key, current)
  console.log('Snapshot updated and Slack notification sent.')
}
