/**
 * Relais Cloudflare Worker pour le calcul des péages via TollGuru.
 *
 * Contourne le blocage CORS : le navigateur appelle ce Worker, qui interroge
 * TollGuru côté serveur et renvoie la réponse avec les en-têtes CORS.
 *
 * Utilise l'endpoint v2 "origin-destination-waypoints" (le seul auquel la clé
 * a accès — l'endpoint polyline renvoie 403 "TollTally").
 *
 * Réponse renvoyée au site : { "cost": <nombre €>|null, ... }
 *
 * ⚠️ Plan gratuit TollGuru = 15 calculs/jour. Au-delà : 403 "exceeded daily
 *    quota". Le site met les trajets en cache pour économiser ce quota.
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
      const { from, to, vehicleType } = await request.json();
      if (!from || !to) return json({ cost: null, error: 'missing from/to' }, 200);

      const r = await fetch(
        'https://apis.tollguru.com/toll/v2/origin-destination-waypoints',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': key },
          body: JSON.stringify({
            from: from,
            to: to,
            vehicle: { type: vehicleType || '2AxlesAuto' },
            currency: 'EUR',
          }),
        }
      );

      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch (e) { data = null; }

      if (r.status === 200 && data && typeof data === 'object') {
        const route = data.route || (data.routes && data.routes[0]) || data;
        if (route && route.hasTolls === false) return json({ cost: 0 }, 200);
        const cost = extractToll(route && route.costs);
        if (cost !== null) return json({ cost: cost }, 200);
      }

      // Échec : on renvoie le statut + un extrait pour diagnostic (ex. quota dépassé).
      return json({ cost: null, status: r.status, body: String(text).slice(0, 250) }, 200);
    } catch (e) {
      return json({ cost: null, error: String(e) }, 200);
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
