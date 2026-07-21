// Recibe el webhook de GoHighLevel cuando se confirma una reunión ("Schedule")
// y manda el evento espejo a Meta Conversions API, con el mismo event_id que
// usa el pixel del navegador en /gracias para deduplicar.
//
// Configurar en GHL: Workflow -> trigger "Appointment Status Changed" (Confirmed)
// -> acción "Webhook" -> POST a https://<tu-dominio>/api/capi con body JSON:
// {
//   "contact_id": "{{contact.id}}",
//   "email": "{{contact.email}}",
//   "phone": "{{contact.phone}}",
//   "fbp": "{{contact.attributionSource.fbp}}",
//   "fbc": "{{contact.attributionSource.fbc}}",
//   "event_source_url": "{{contact.attributionSource.url}}"
// }
// (los nombres exactos de los custom fields de attribution pueden variar
// según tu configuración de GHL; ajustar el mapeo si hace falta)

const crypto = require('crypto');

const PIXEL_ID = '1226630459322247';

function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  if (!accessToken) {
    res.status(500).json({ error: 'META_CAPI_ACCESS_TOKEN not configured' });
    return;
  }

  const body = req.body || {};
  const contactId = body.contact_id || body.contactId;
  const email = body.email;
  const phone = body.phone;
  const fbp = body.fbp;
  const fbc = body.fbc;
  const eventSourceUrl = body.event_source_url || 'https://camelionmedia.com/gracias';

  const eventId = contactId ? `schedule_${contactId}` : `schedule_${Date.now()}`;

  const userData = {
    em: sha256(email),
    ph: sha256(phone),
    fbp: fbp || undefined,
    fbc: fbc || undefined,
  };
  Object.keys(userData).forEach((k) => userData[k] === undefined && delete userData[k]);

  const payload = {
    data: [
      {
        event_name: 'Schedule',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'website',
        event_source_url: eventSourceUrl,
        user_data: userData,
      },
    ],
  };

  try {
    const metaRes = await fetch(
      `https://graph.facebook.com/v20.0/${PIXEL_ID}/events?access_token=${accessToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    const metaJson = await metaRes.json();
    if (!metaRes.ok) {
      res.status(502).json({ error: 'Meta CAPI error', details: metaJson });
      return;
    }
    res.status(200).json({ ok: true, event_id: eventId, meta: metaJson });
  } catch (err) {
    res.status(500).json({ error: 'Request to Meta failed', details: String(err) });
  }
};
