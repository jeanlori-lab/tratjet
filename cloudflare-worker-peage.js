/**
 * Relais Cloudflare Worker pour le calcul des péages via TollGuru.
 *
 * Pourquoi : l'API TollGuru bloque les appels directs depuis un navigateur (CORS).
 * Ce Worker fait l'appel côté serveur et renvoie la réponse avec les en-têtes CORS,
 * pour que le site statique (GitHub Pages) puisse l'utiliser.
 *
 * Déploiement :
 *  1. Crée un compte gratuit sur https://dash.cloudflare.com
 *  2. Workers & Pages → Create → Create Worker → donne-lui un nom (ex. "peage")
 *  3. "Edit code", colle TOUT ce fichier, puis "Deploy"
 *  4. (Recommandé) Settings → Variables → ajoute une variable TOLLGURU_KEY
 *     avec ta clé. Sinon la valeur par défaut ci-dessous est utilisée.
 *  5. Copie l'URL du Worker (ex. https://peage.toncompte.workers.dev)
 *     et colle-la dans index.html à la constante TOLL_PROXY_URL.
 */

const DEFAULT_TOLLGURU_KEY = 'tg_F9E2FD106CAA46B38658750E2C0872E6';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

    const key = (env && env.TOLLGURU_KEY) || DEFAULT_TOLLGURU_KEY;

    try {
      const { polyline, vehicleType } = await request.json();
      if (!polyline) {
        return json({ error: 'missing polyline' }, 400);
      }

      const r = await fetch(
        'https://apis.tollguru.com/toll/v2/complete-polyline-from-mapping-service',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': key },
          body: JSON.stringify({
            source: 'google',
            polyline: polyline,
            vehicle: { type: vehicleType || '2AxlesAuto' },
            currency: 'EUR',
          }),
        }
      );

      const body = await r.text();
      return new Response(body, {
        status: r.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
