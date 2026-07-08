/**
 * Relais Cloudflare Worker pour le calcul des péages.
 *
 * Contourne le blocage CORS : le navigateur appelle ce Worker, qui interroge
 * l'API côté serveur (TollGuru, ou Vinci-autoroutes en secours) et renvoie
 * la réponse avec les en-têtes CORS.
 *
 * Trois usages, distingués par le corps de la requête POST :
 *  - { from, to, vehicleType }         -> TollGuru (source principale)
 *  - { action: 'vinci-legs', polyline } -> Vinci : tracé -> gares de péage
 *  - { action: 'vinci-rate', ... }      -> Vinci : gares de péage -> tarif
 *
 * TollGuru : endpoint v2 "origin-destination-waypoints" (le seul auquel la
 * clé a accès — l'endpoint polyline renvoie 403 "TollTally").
 * Réponse renvoyée au site pour TollGuru : { "cost": <nombre €>|null, ... }
 * ⚠️ Plan gratuit TollGuru = 15 calculs/jour. Au-delà : 403 "exceeded daily
 *    quota". Le site met les trajets en cache pour économiser ce quota, et
 *    bascule automatiquement sur Vinci si TollGuru échoue.
 *
 * Vinci-autoroutes : API interne non documentée (clé "Ocp-Apim-Subscription-
 * Key" trouvée dans le JS public du site), reverse-engineered depuis l'onglet
 * Réseau du site officiel. Peut casser sans prévenir si Vinci la modifie —
 * c'est un repli best-effort, pas une garantie.
 *
 * Déploiement : Cloudflare → Workers & Pages → ton Worker → Edit code →
 *   coller TOUT ce fichier → Deploy.
 * (Recommandé : Settings → Variables → TOLLGURU_KEY et ULYS_KEY = tes clés.)
 */

const DEFAULT_TOLLGURU_KEY = 'tg_F9E2FD106CAA46B38658750E2C0872E6';
const DEFAULT_ULYS_KEY = '43d92b9382b14bb9bec5397be3b415be';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS });

    let body;
    try { body = await request.json(); } catch (e) { return json({ cost: null, error: 'invalid json' }, 200); }

    if (body && body.action === 'vinci-legs') return handleVinciLegs(body, env);
    if (body && body.action === 'vinci-rate') return handleVinciRate(body, env);
    return handleTollGuru(body, env);
  },
};

async function handleTollGuru(body, env) {
  const key = (env && env.TOLLGURU_KEY) || DEFAULT_TOLLGURU_KEY;
  const { from, to, vehicleType } = body || {};
  if (!from || !to) return json({ cost: null, error: 'missing from/to' }, 200);

  try {
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
}

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

// --- Vinci-autoroutes (repli, cf. commentaire d'en-tête) ---

function ulysHeaders(env) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Ocp-Apim-Subscription-Key': (env && env.ULYS_KEY) || DEFAULT_ULYS_KEY,
    'x-calling-product': 'SITE-VA-V2',
    'Origin': 'https://www.vinci-autoroutes.com',
    'Referer': 'https://www.vinci-autoroutes.com/',
  };
}

async function handleVinciLegs(body, env) {
  const polyline = body && body.polyline;
  if (typeof polyline !== 'string') return json([], 200);
  try {
    const r = await fetch(
      'https://api-ulys.azure-api.net/placemark/v2/legs?precision=6&includeLayersIds=GaresPeage',
      { method: 'POST', headers: ulysHeaders(env), body: JSON.stringify(polyline) }
    );
    if (!r.ok) return json([], 200);
    const data = await r.json();
    return json(data, 200);
  } catch (e) {
    return json([], 200);
  }
}

async function handleVinciRate(body, env) {
  const { vehicleCategory, paymentOption, tollPassages } = body || {};
  if (!Array.isArray(tollPassages) || !tollPassages.length) return json([], 200);
  try {
    const r = await fetch(
      'https://api-ulys.azure-api.net/tollstation/v1/rate',
      {
        method: 'POST',
        headers: ulysHeaders(env),
        body: JSON.stringify({
          vehicleCategory: vehicleCategory || 1,
          paymentOption: paymentOption || 2,
          tollPassages: tollPassages,
        }),
      }
    );
    if (!r.ok) return json([], 200);
    const data = await r.json();
    return json(data, 200);
  } catch (e) {
    return json([], 200);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
