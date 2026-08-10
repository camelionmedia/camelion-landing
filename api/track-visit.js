module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    res.status(500).json({ error: 'Redis not configured' });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const headers = { Authorization: `Bearer ${token}` };

  try {
    const [r1, r2] = await Promise.all([
      fetch(`${url}/incr/visits:camelion:total`, { headers }),
      fetch(`${url}/incr/visits:camelion:${today}`, { headers }),
    ]);
    if (!r1.ok || !r2.ok) {
      const [b1, b2] = await Promise.all([r1.text().catch(() => ''), r2.text().catch(() => '')]);
      res.status(502).json({ error: 'Upstash rejected the request', status: [r1.status, r2.status], body: [b1, b2] });
      return;
    }
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Upstash', details: String(err) });
    return;
  }

  res.status(204).end();
};
