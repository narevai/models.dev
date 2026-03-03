import type { MonitorOptions } from './types.ts'
import { loadSnapshot, saveSnapshot } from './s3.ts'
import { sendSlack, buildSlackBlocks } from './slack.ts'

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
      [{ type: 'section', text: { type: 'mrkdwn', text: `*🛰 ${name} Monitor initialized*\nTracking *${current.length} models*. Future runs will report changes.\n\`s3://${bucket}/${s3Key}\`` } }],
    )
    console.log('Done.')
    return
  }

  console.log(`  Previous snapshot: ${previous.models.length} models (${previous.timestamp})`)

  const prevMap = new Map(previous.models.map(m => [m.id, m]))
  const currMap = new Map(current.map(m => [m.id, m]))

  const added = current.filter(m => !prevMap.has(m.id))
  const removed = previous.models.filter(m => !currMap.has(m.id))
  const priceChanges = current
    .filter(m => {
      const prev = prevMap.get(m.id)
      return prev && (prev.price_prompt !== m.price_prompt || prev.price_completion !== m.price_completion)
    })
    .map(m => {
      const prev = prevMap.get(m.id)!
      return { id: m.id, old_prompt: prev.price_prompt, new_prompt: m.price_prompt, old_completion: prev.price_completion, new_completion: m.price_completion }
    })

  console.log(`  Added: ${added.length} | Removed: ${removed.length} | Price changes: ${priceChanges.length}`)

  if (!added.length && !removed.length && !priceChanges.length) {
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
