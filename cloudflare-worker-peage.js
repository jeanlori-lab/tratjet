/**
 * Relais Cloudflare Worker pour le calcul des péages.
 *
 * Contourne le blocage CORS : le navigateur appelle ce Worker, qui interroge
 * l'API côté serveur (ViaMichelin en source principale, Vinci-autoroutes en
 * second recours) et renvoie la réponse avec les en-têtes CORS.
 *
 * Trois usages, distingués par le corps de la requête POST :
 *  - { action: 'viamichelin', ... }      -> ViaMichelin : tracé -> coûts détaillés (source principale)
 *  - { action: 'vinci-legs', polyline }   -> Vinci : tracé -> gares de péage (second recours)
 *  - { action: 'vinci-rate', ... }        -> Vinci : gares de péage -> tarif
 *
 * Vinci-autoroutes et ViaMichelin : APIs internes non documentées,
 * reverse-engineered depuis l'onglet Réseau des sites officiels (clé Vinci
 * "Ocp-Apim-Subscription-Key" trouvée dans le JS public du site ; ViaMichelin
 * n'a pas de clé, juste un contrôle Origin/Referer usurpé ici). Peuvent
 * casser sans prévenir si le site change — ce sont des replis best-effort,
 * pas une garantie.
 *
 * TollGuru (utilisé un temps comme dernier repli) a été retiré — le code est
 * conservé dans archive/tollguru.md au cas où on voudrait le réintégrer.
 *
 * Déploiement : Cloudflare → Workers & Pages → ton Worker → Edit code →
 *   coller TOUT ce fichier → Deploy.
 * (Recommandé : Settings → Variables → ULYS_KEY = ta clé.)
 */

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
    if (body && body.action === 'viamichelin') return handleViaMichelin(body, env);
    return json({ cost: null, error: 'unknown action' }, 200);
  },
};

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

// --- ViaMichelin (repli, cf. commentaire d'en-tête) ---
// GraphQL public (bff.viamichelin.com), pas de clé : juste Origin/Referer
// usurpés ici pour passer le contrôle CORS/anti-bot basique du site.
// carId fixe (Renault Clio V essence) : les péages dépendent de la catégorie
// du véhicule (léger), pas du modèle exact, donc une voiture "standard"
// suffit — Tratjet ne s'en sert que pour le tarif péages, jamais pour le
// carburant (déjà calculé par Tratjet lui-même avec la conso réelle saisie).
const VIAMICHELIN_CAR_ID = '29074';
const VIAMICHELIN_QUERY = `query SearchItinerary($input: SearchItineraryInput!) {
  searchItinerary(input: $input) {
    ... on SearchItinerarySuccessResult {
      __typename
      routes {
        costs {
          fuel { amount currency }
          tolls { amount currency }
          vignette { amount currency }
        }
        totalCost { amount currency }
        tolls { name cost { amount currency } }
      }
    }
    ... on SearchItineraryNotFoundResult { message }
    __typename
  }
}`;

async function handleViaMichelin(body, env) {
  const { coordinates, departureName, arrivalName, energyCost } = body || {};
  if (!Array.isArray(coordinates) || coordinates.length < 2) return json({ cost: null, error: 'missing coordinates' }, 200);
  try {
    const r = await fetch('https://bff.viamichelin.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/graphql+json, application/json',
        'Origin': 'https://www.viamichelin.fr',
        'Referer': 'https://www.viamichelin.fr/',
        'platform': 'WEB_TABLET',
      },
      body: JSON.stringify({
        operationName: 'SearchItinerary',
        query: VIAMICHELIN_QUERY,
        variables: {
          input: {
            coordinates,
            departureName: departureName || '',
            arrivalName: arrivalName || '',
            carId: VIAMICHELIN_CAR_ID,
            constraint: 'NONE',
            distanceSystem: 'METRIC',
            mode: 'CAR',
            device: 'DESKTOP',
            energyCost: typeof energyCost === 'number' ? energyCost : 1.9,
            currency: 'eur',
            rechargeTreshold: 20,
            traffic: 'CLOSINGS',
            temperatureMode: 'summer',
          },
        },
      }),
    });
    if (!r.ok) return json({ cost: null, status: r.status }, 200);
    const data = await r.json();
    return json(data, 200);
  } catch (e) {
    return json({ cost: null, error: String(e) }, 200);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
