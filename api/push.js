import { Redis } from '@upstash/redis';
import webpush from 'web-push';

const redis = Redis.fromEnv();

const LEVELS = [
  { max: 2,        advice: 'SPF не нужен 😎',           spf: false },
  { max: 5,        advice: 'SPF 15–30 по желанию',      spf: false },
  { max: 7,        advice: 'Намажь SPF 30+ ☀️',         spf: true  },
  { max: 10,       advice: 'Обязательно SPF 50+ ☀️',    spf: true  },
  { max: Infinity, advice: 'SPF 50+, меньше солнца ☀️', spf: true  },
];

function getLevel(uv) {
  return LEVELS.find(l => uv <= l.max);
}

// Is current local time between 9:00 and 17:00?
function isInDaytime(timezone) {
  try {
    const now = new Date();
    const hour = parseInt(
      now.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit' }),
      10
    );
    return hour >= 9 && hour < 17;
  } catch (_) {
    return true; // fallback: always send
  }
}

// Has enough time passed since last notification?
function isIntervalReached(lastSentMs, intervalMinutes) {
  if (!lastSentMs) return true;
  const elapsed = Date.now() - Number(lastSentMs);
  return elapsed >= intervalMinutes * 60 * 1000;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const subRaw    = await redis.get('push_subscription');
    const coordsRaw = await redis.get('push_coords');
    const timezone  = (await redis.get('push_timezone')) || 'UTC';
    const interval  = parseInt(await redis.get('push_interval') || '60', 10);
    const lastSent  = await redis.get('push_last_sent');

    if (!subRaw || !coordsRaw) {
      return res.status(404).json({ error: 'No subscription or coords stored' });
    }

    // TODO: раскомментировать после тестирования
    // if (!req.query.force && !isInDaytime(timezone)) {
    //   return res.status(200).json({ ok: true, skipped: true, reason: 'outside daytime' });
    // }
    // if (!req.query.force && !isIntervalReached(lastSent, interval)) {
    //   return res.status(200).json({ ok: true, skipped: true, reason: 'interval not reached' });
    // }

    const subscription = typeof subRaw === 'string' ? JSON.parse(subRaw) : subRaw;
    const coords       = typeof coordsRaw === 'string' ? JSON.parse(coordsRaw) : coordsRaw;

    // Fetch UV
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=uv_index&timezone=auto`
    );
    const data = await r.json();
    const uv = data.current?.uv_index ?? 0;
    const level = getLevel(uv);
    const body = `UV ${uv.toFixed(1)} — ${level.advice}`;

    // Send push
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    await webpush.sendNotification(subscription, JSON.stringify({ title: 'UV Guard', body }));

    // Save last sent timestamp
    await redis.set('push_last_sent', Date.now().toString());

    res.status(200).json({ ok: true, uv, body });

  } catch (err) {
    console.error('Push error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
