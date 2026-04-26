import { Redis } from '@upstash/redis';
import webpush from 'web-push';

const redis = Redis.fromEnv();

const LEVELS = [
  { max: 2,        advice: 'Живи. Сегодня солнце тебя не хочет.',                             spf: false },
  { max: 5,        advice: 'Рак кожи с первого раза не бывает. Продолжай в том же духе.',   spf: false },
  { max: 7,        advice: 'Намажься. Или не надо, меланома сама себя не вырастит.',         spf: true  },
  { max: 10,       advice: 'Красивый коричневый цвет. Гроб тоже будет красивый.',            spf: true  },
  { max: Infinity, advice: 'Это уже не загар. Это заявка на биопсию. Загорай, красавчик.',   spf: true  },
];

function getLevel(uv) {
  return LEVELS.find(l => uv <= l.max);
}

// Check if current local time hits a notification slot.
// Slots are fixed: every `intervalMinutes` starting from 9:00, within 9:00–17:00.
// Examples (interval 120): 9:00, 11:00, 13:00, 15:00 → 4 notifications/day
function isNotifySlot(timezone, intervalMinutes) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  }); // "HH:MM"
  const [h, m] = timeStr.split(':').map(Number);

  if (h < 9 || h >= 17) return false;

  const minutesSince9 = (h - 9) * 60 + m;
  return minutesSince9 % intervalMinutes === 0;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const subRaw   = await redis.get('push_subscription');
    const coordsRaw = await redis.get('push_coords');
    const timezone  = (await redis.get('push_timezone')) || 'UTC';
    const interval  = parseInt(await redis.get('push_interval') || '60', 10);

    if (!subRaw || !coordsRaw) {
      return res.status(404).json({ error: 'No subscription or coords stored' });
    }

    if (!req.query.force && !isNotifySlot(timezone, interval)) {
      return res.status(200).json({ ok: true, skipped: true, timezone, interval });
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
    await webpush.sendNotification(subscription, JSON.stringify({ title: 'UV Guard', body }));

    res.status(200).json({ ok: true, uv, body, timezone, interval });

  } catch (err) {
    console.error('Push error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
