/**
 * Relais Cloudflare Worker pour le calcul des péages via TollGuru.
 *
 * Essaie plusieurs endpoints/formats TollGuru et renvoie le premier qui marche,
 * avec un diagnostic complet ("attempts") pour voir ce que l'API répond.
 *
 * Réponse renvoyée au site :
 *   { "cost": <nombre €>|null, "via": "...", "attempts": [...] }
 *
 * Déploiement : Cloudflare → Workers & Pages → ton Worker → Edit code →
 *   coller TOUT ce fichier → Deploy.
 * (Recommandé : Settings → Variables → TOLLGURU_KEY = ta clé.)
 */

const DEFAULT_TOLLGURU_KEY = 'tg_F9E2FD106CAA46B38658750E2C0872E6';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS });

    const key = (env && env.TOLLGURU_KEY) || DEFAULT_TOLLGURU_KEY;

    try {
      const { polyline, from, to, vehicleType } = await request.json();
      const vt = vehicleType || '2AxlesAuto';
      const attempts = [];

      // Liste des tentatives (endpoint + corps), de la plus précise à la plus simple.
      const tries = [];

      // 1) API v2 polyline (la plus précise).
      if (polyline) {
        tries.push({
          via: 'v2-polyline',
          url: 'https://apis.tollguru.com/toll/v2/complete-polyline-from-mapping-service',
          body: { source: 'google', polyline, vehicle: { type: vt }, currency: 'EUR' },
        });
      }
      // 2) API v2 origin/destination (souvent dispo quand la polyline ne l'est pas).
      if (from && to) {
        tries.push({
          via: 'v2-origin-destination',
          url: 'https://apis.tollguru.com/toll/v2/origin-destination-waypoints',
          body: { from, to, vehicle: { type: vt }, currency: 'EUR' },
        });
      }
      // 3) Ancien endpoint (legacy), plusieurs valeurs de source.
      if (polyline) {
        for (const source of ['gmaps', 'here']) {
          tries.push({
            via: 'legacy-' + source,
            url: 'https://dev.api.tollguru.com/v1/calc/route',
            body: { source, polyline, vehicleType: vt },
          });
        }
      }

      for (const t of tries) {
        try {
          const r = await fetch(t.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': key },
            body: JSON.stringify(t.body),
          });
          const text = await r.text();
          let data;
          try { data = JSON.parse(text); } catch (e) { data = null; }
          attempts.push({ via: t.via, status: r.status, body: String(text).slice(0, 250) });

          if (r.status === 200 && data && typeof data === 'object') {
            const route = data.route || (data.routes && data.routes[0]) || data;
            if (route && route.hasTolls === false) return json({ cost: 0, via: t.via, attempts }, 200);
            const cost = extractToll(route && route.costs);
            if (cost !== null) return json({ cost, via: t.via, attempts }, 200);
          }
        } catch (e) {
          attempts.push({ via: t.via, error: String(e) });
        }
      }

      return json({ cost: null, attempts }, 200);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};

function extractToll(costs) {
  if (!costs || typeof costs !== 'object') return null;
  const candidats = [
    costs.tag, costs.cash, costs.creditCard, costs.licensePlate,
    costs.minimumTollCost, costs.maximumTollCost, costs.prepaidCard,
  ];
  for (const c of candidats) {
    const n = parseFloat(c);
    if (c !== undefined && c !== null && !isNaN(n)) return n;
  }
  return null;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
