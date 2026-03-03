import type { ModelEntry, PriceChange } from './types.ts'
import { formatPrice, priceArrow, pctChange, truncateList } from './helpers.ts'

type SlackBlock = Record<string, unknown>

export async function sendSlack(fallbackText: string, blocks: SlackBlock[]): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL ?? ''
  if (!webhookUrl) {
    console.log('[Slack] No SLACK_WEBHOOK_URL set — skipping notification')
    return
  }
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: fallbackText, blocks }),
  })
  if (!res.ok) console.error(`[Slack] Webhook error: ${res.status} ${await res.text()}`)
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
    const lines = added.map(m => `• \`${m.id}\`\n  *in:* ${formatPrice(m.price_prompt)}/1M  *out:* ${formatPrice(m.price_completion)}/1M`)
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `✅ *New models (${added.length})*\n\n${truncateList(lines, 20, '\n\n')}` } })
  }

  if (removed.length > 0) {
    const lines = removed.map(m => `• \`${m.id}\``)
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `❌ *Removed models (${removed.length})*\n\n${truncateList(lines, 20, '\n\n')}` } })
  }

  if (priceChanges.length > 0) {
    const lines = priceChanges.map(c => {
      const parts: string[] = []
      if (c.old_prompt !== c.new_prompt)
        parts.push(`*in:* ${formatPrice(c.old_prompt)} ${priceArrow(c.old_prompt, c.new_prompt)} ${formatPrice(c.new_prompt)}/1M${pctChange(c.old_prompt, c.new_prompt)}`)
      if (c.old_completion !== c.new_completion)
        parts.push(`*out:* ${formatPrice(c.old_completion)} ${priceArrow(c.old_completion, c.new_completion)} ${formatPrice(c.new_completion)}/1M${pctChange(c.old_completion, c.new_completion)}`)
      return `• \`${c.id}\`\n  ${parts.join('  ')}`
    })
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `💰 *Price changes (${priceChanges.length})*\n\n${truncateList(lines, 20, '\n\n')}` } })
  }

  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Checked at ${new Date().toISOString()} | Previous snapshot: ${previousTimestamp}` }] })

  return blocks
}
