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

// Notify times in local HH:MM
const NOTIFY_TIMES = ['10:00', '12:00', '14:30', '23:30'];

function isNotifyTime(timezone) {
  try {
    const now = new Date();
    const localTime = now.toLocaleTimeString('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
    }); // → "10:00"
    return NOTIFY_TIMES.includes(localTime);
  } catch (_) {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).end();
  }

  // Secret check
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const subRaw      = await redis.get('push_subscription');
    const coordsRaw   = await redis.get('push_coords');
    const timezone    = await redis.get('push_timezone') || 'UTC';

    if (!subRaw || !coordsRaw) {
      return res.status(404).json({ error: 'No subscription or coords stored' });
    }

    // Check if it's the right local time (cron runs every 30 min)
    // Skip unless forced with ?force=1
    if (!req.query.force && !isNotifyTime(timezone)) {
      return res.status(200).json({ ok: true, skipped: true, timezone, msg: 'Not a notify time' });
    }

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

    await webpush.sendNotification(
      subscription,
      JSON.stringify({ title: 'UV Guard', body })
    );

    res.status(200).json({ ok: true, uv, body, timezone });

  } catch (err) {
    console.error('Push error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
