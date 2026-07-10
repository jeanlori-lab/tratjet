# TollGuru — code retiré (2026-07-10)

Retiré de `index.html` et `cloudflare-worker-peage.js` à la demande de
l'utilisateur, TollGuru n'étant plus utile comme repli maintenant que
ViaMichelin (principal) et Vinci-autoroutes (second recours) couvrent les
péages avec un détail par gare nommée. Conservé ici au cas où on voudrait le
remettre plus tard (ex. si ViaMichelin et Vinci deviennent tous les deux
indisponibles).

Pour réintégrer : recoller chaque bloc ci-dessous à son emplacement d'origine
(indiqué en commentaire), rebrancher l'appel dans `getTolls()` et la route
`handleTollGuru` dans le Worker.

## `index.html` — dans le `<script>` principal

### Constante (à côté de `TOLL_PROXY_URL`)

```js
// URL du relais Cloudflare Worker qui appelle TollGuru (contourne le blocage CORS).
// ⚠️ Colle ici l'URL de TON Worker, ex : https://peage.toncompte.workers.dev
const TOLL_PROXY_URL = 'https://peage.jeanlorilleux37.workers.dev/';
```
(cette ligne existe toujours — le Worker sert aussi de relais pour Vinci et
ViaMichelin, elle n'a pas été retirée)

### Suivi du quota (15 requêtes / 24h glissantes)

```js
// Suivi du quota TollGuru (15 requêtes / 24 h glissantes), estimé côté navigateur :
// on horodate chaque appel réellement consommé (ni cache, ni refus quota).
const TOLL_QUOTA_MAX = 15;
const TOLL_QUOTA_WINDOW = 24 * 3600 * 1000;
function tollQuotaCalls() {
  let arr;
  try { arr = JSON.parse(localStorage.getItem('tollQuotaCalls') || '[]'); } catch(e) { arr = []; }
  const cutoff = Date.now() - TOLL_QUOTA_WINDOW;
  arr = arr.filter(t => t > cutoff);
  try { localStorage.setItem('tollQuotaCalls', JSON.stringify(arr)); } catch(e) {}
  return arr;
}
function tollQuotaRemaining() {
  return Math.max(0, TOLL_QUOTA_MAX - tollQuotaCalls().length);
}
function recordTollCall() {
  const arr = tollQuotaCalls();
  arr.push(Date.now());
  try { localStorage.setItem('tollQuotaCalls', JSON.stringify(arr)); } catch(e) {}
}
```

### Fonction de récupération (dernier repli dans `getTolls()`)

```js
async function getTollsGuru(polyline, c1, c2) {
  try {
    // c1/c2 sont des coordonnées [lng, lat] (format ORS/GeoJSON).
    const from = c1 ? { lat: c1[1], lng: c1[0] } : null;
    const to   = c2 ? { lat: c2[1], lng: c2[0] } : null;
    const r = await fetch(TOLL_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ polyline: polyline, from: from, to: to, vehicleType: '2AxlesAuto' })
    });
    const d = await r.json();
    // Le Worker renvoie un coût normalisé { cost: <nombre|null> }.
    let cost = null;
    if (typeof d.cost === 'number') {
      cost = d.cost;
    } else if (d.cost === undefined) {
      // Compat : ancienne forme (réponse brute TollGuru).
      if (d.route && d.route.hasTolls === false) cost = 0;
      else {
        const costs = (d.route && d.route.costs)
          || (d.routes && d.routes[0] && d.routes[0].costs)
          || d.costs;
        cost = extractToll(costs);
      }
    }
    // Un coût obtenu par appel réseau = 1 transaction TollGuru consommée.
    if (typeof cost === 'number') recordTollCall();
    return cost;
  } catch(e) {
    return null;
  }
}

function extractToll(costs) {
  if (!costs || typeof costs !== 'object') return null;
  // On parcourt les champs de coût possibles, du plus pertinent au plus générique.
  const candidats = [
    costs.tag, costs.cash, costs.creditCard, costs.licensePlate,
    costs.minimumTollCost, costs.maximumTollCost, costs.prepaidCard, costs.EUR
  ];
  for (const c of candidats) {
    const n = parseFloat(c);
    if (c !== undefined && c !== null && !isNaN(n)) return n;
  }
  return null;
}
```

### Appel dans l'orchestrateur `getTolls()`

Dans `getTolls()`, après l'essai Vinci :

```js
  if (!result) {
    const cost = await getTollsGuru(polyline, c1, c2);
    if (typeof cost === 'number') result = { cost, details: null };
  }
```

### CSS du compteur de quota (jamais branché à l'affichage, laissé de côté à l'époque)

```css
.cost-chip-quota { font-size: 8.5px; font-weight: 600; color: #b0bcc8; margin-top: 2px; }
```

## `cloudflare-worker-peage.js`

### Constante de clé par défaut

```js
const DEFAULT_TOLLGURU_KEY = 'tg_F9E2FD106CAA46B38658750E2C0872E6';
```

### Route dans `fetch()`

```js
    return handleTollGuru(body, env);
```
(était le cas par défaut, quand `action` ne correspondait à aucune des autres routes)

### Handler complet

```js
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
```
