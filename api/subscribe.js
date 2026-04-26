import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { subscription, lat, lon, timezone } = req.body;
  if (!subscription) return res.status(400).json({ error: 'No subscription' });

  await redis.set('push_subscription', JSON.stringify(subscription));
  if (lat && lon) await redis.set('push_coords', JSON.stringify({ lat, lon }));
  if (timezone) await redis.set('push_timezone', timezone);

  res.status(200).json({ ok: true });
}
