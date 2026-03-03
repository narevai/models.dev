import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type { ModelEntry, Snapshot } from './types.ts'

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1' })

export async function loadSnapshot(bucket: string, key: string): Promise<Snapshot | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    return JSON.parse(await res.Body!.transformToString()) as Snapshot
  } catch (e: any) {
    if (e.name === 'NoSuchKey' || e.Code === 'NoSuchKey') return null
    throw e
  }
}

export async function saveSnapshot(bucket: string, key: string, models: ModelEntry[]): Promise<void> {
  const snapshot: Snapshot = { timestamp: new Date().toISOString(), models }
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(snapshot, null, 2),
    ContentType: 'application/json',
  }))
}
