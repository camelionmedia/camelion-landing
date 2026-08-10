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

  await Promise.all([
    fetch(`${url}/incr/visits:camelion:total`, { headers }),
    fetch(`${url}/incr/visits:camelion:${today}`, { headers }),
  ]).catch(() => {});

  res.status(204).end();
};
