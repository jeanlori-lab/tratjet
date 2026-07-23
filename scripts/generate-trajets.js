#!/usr/bin/env node
/**
 * Génère les pages trajet SEO (trajets/<slug>.html) à partir des trajets
 * listés dans trajets/trajets.json, en réutilisant les VRAIS calculs de
 * l'application (aucun tarif inventé) : chaque page est produite en
 * chargeant index.html dans un navigateur headless avec ?from=&to=, en
 * attendant le résultat réel, puis en l'injectant dans un gabarit statique.
 *
 * Nécessite un accès réseau réel aux APIs (BAN, ORS, data.gouv.fr, Worker
 * péages) : à exécuter via `npm run generate:trajets` en local, ou via le
 * workflow GitHub Actions .github/workflows/generate-trajets.yml (déclenché
 * manuellement), jamais dans un environnement au réseau restreint.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TRAJETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'trajets/trajets.json'), 'utf8'));
const SITE_URL = 'https://futeroute.fr';
const PORT = 8973;

function fmtEur(n) {
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}
function fmtDuree(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h} h ${m > 0 ? m + ' min' : ''}`.trim() : `${m} min`;
}
function fmtKm(n) {
  return Math.round(n).toLocaleString('fr-FR') + ' km';
}

// Sert le dépôt en statique le temps de la génération (index.html seul suffit).
function startServer() {
  const server = http.createServer((req, res) => {
    let filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (req.url === '/' || req.url.startsWith('/?')) filePath = path.join(ROOT, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': filePath.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(PORT, () => resolve(server)));
}

async function calculerTrajet(browser, depart, arrivee) {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/index.html?from=${encodeURIComponent(depart)}&to=${encodeURIComponent(arrivee)}`);
  // Attend que le calcul réel (géocodage + itinéraire + péages) ait abouti.
  await page.waitForFunction(
    () => typeof routeOptionsData !== 'undefined' && routeOptionsData && routeOptionsData.rapide && typeof routeOptionsData.rapide.coutA === 'number',
    { timeout: 30000 },
  );
  const data = await page.evaluate(() => {
    const o = routeOptionsData;
    const r = o.rapide, z = o.zero || null;
    return {
      distanceKm: r.distA, dureeSec: r.dureeSec, coutCarburant: r.coutA,
      coutPeage: typeof r.coutPeage === 'number' ? r.coutPeage : null,
      peageSource: r.peageSource || null,
      zero: z ? { distanceKm: z.distA, dureeSec: z.dureeSec, coutCarburant: z.coutA } : null,
    };
  });
  await page.close();
  return data;
}

function verdictSansPeages(rapide, zero) {
  if (!zero || typeof rapide.coutPeage !== 'number') return null;
  const totalRapide = rapide.coutCarburant + rapide.coutPeage;
  const totalZero = zero.coutCarburant;
  const dE = totalRapide - totalZero;
  const dT = zero.dureeSec - rapide.dureeSec;
  if (dE <= 0.5) return { rentable: false, texte: `Éviter les péages ne fait pas économiser sur ce trajet (${fmtEur(Math.abs(dE))} de différence, pour ${fmtDuree(Math.abs(dT))} de plus) : autant prendre l'autoroute.` };
  return { rentable: true, dE, dT, texte: `Éviter les péages fait économiser ${fmtEur(dE)}, au prix de ${fmtDuree(dT)} de trajet en plus.` };
}

// Liens internes : autres trajets partageant une ville (départ ou arrivée)
// avec le trajet courant. Aide Google à explorer, et garde le visiteur sur le
// site. On ne relie qu'aux trajets RÉUSSIS (passés en paramètre), donc aucun
// lien mort.
function relatedLinks(t, all) {
  return all.filter(o => o.slug !== t.slug &&
    (o.depart === t.depart || o.arrivee === t.arrivee ||
     o.depart === t.arrivee || o.arrivee === t.depart)).slice(0, 8);
}

function renderPage(t, r, all) {
  const title = `Trajet ${t.depart} → ${t.arrivee} : coût, péages, faut-il éviter l'autoroute ? | Futéroute`;
  const totalRapide = r.coutCarburant + (r.coutPeage || 0);
  const verdict = verdictSansPeages(r, r.zero);
  const dateMaj = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const appUrl = `${SITE_URL}/index.html?from=${encodeURIComponent(t.depart)}&to=${encodeURIComponent(t.arrivee)}`;

  const faq = [
    {
      q: `Combien coûte le trajet ${t.depart} - ${t.arrivee} en voiture ?`,
      a: `Comptez environ ${fmtEur(totalRapide)} (carburant + péages, base SP95 à 6,6 L/100 km) pour ${fmtKm(r.distanceKm)}, soit ${fmtDuree(r.dureeSec)} de route.`
        + (typeof r.coutPeage === 'number' ? ` Les péages représentent ${fmtEur(r.coutPeage)} de ce total.` : ''),
    },
    {
      q: `Vaut-il le coup d'éviter les péages entre ${t.depart} et ${t.arrivee} ?`,
      a: verdict ? verdict.texte : `Le prix des péages n'a pas pu être déterminé pour ce trajet ; recalculez-le dans l'outil pour un chiffrage à jour.`,
    },
  ].map(f => `<div class="faq-item"><h3>${f.q}</h3><p>${f.a}</p></div>`).join('\n');

  const faqSchema = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: `Combien coûte le trajet ${t.depart} - ${t.arrivee} en voiture ?`,
        acceptedAnswer: { '@type': 'Answer', text: `Environ ${fmtEur(totalRapide)} pour ${fmtKm(r.distanceKm)} (${fmtDuree(r.dureeSec)}).` } },
      { '@type': 'Question', name: `Vaut-il le coup d'éviter les péages entre ${t.depart} et ${t.arrivee} ?`,
        acceptedAnswer: { '@type': 'Answer', text: verdict ? verdict.texte : 'Non déterminé.' } },
    ],
  };

  // Fil d'Ariane en données structurées (rich result dans Google).
  const breadcrumbSchema = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Futéroute', item: `${SITE_URL}/` },
      { '@type': 'ListItem', position: 2, name: 'Trajets', item: `${SITE_URL}/trajets/` },
      { '@type': 'ListItem', position: 3, name: `${t.depart} → ${t.arrivee}`, item: `${SITE_URL}/trajets/${t.slug}.html` },
    ],
  };

  const rel = relatedLinks(t, all || []);
  const relatedHtml = rel.length ? `
  <div class="card">
    <h2 class="rel-title">Autres trajets à comparer</h2>
    <ul class="related">
      ${rel.map(o => `<li><a href="./${o.slug}.html">${o.depart} → ${o.arrivee}</a></li>`).join('\n      ')}
    </ul>
    <p class="rel-all"><a href="./">Voir tous les trajets →</a></p>
  </div>` : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${t.depart} → ${t.arrivee} : ${fmtEur(totalRapide)} (carburant + péages), ${fmtKm(r.distanceKm)}, ${fmtDuree(r.dureeSec)}. ${verdict ? verdict.texte : ''} Chiffres mis à jour le ${dateMaj}.">
<link rel="canonical" href="${SITE_URL}/trajets/${t.slug}.html">
<meta property="og:title" content="${t.depart} → ${t.arrivee} : ${fmtEur(totalRapide)}">
<meta property="og:type" content="article">
<meta property="og:image" content="${SITE_URL}/logo%20trajet%20rat.png">
<link rel="icon" href="../favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="96x96" href="../favicon.png">
<script type="application/ld+json">${JSON.stringify(faqSchema)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #eef2f6; color: #1a2433; padding: 24px 16px; line-height: 1.5; }
  .page { max-width: 640px; margin: 0 auto; }
  .breadcrumb { font-size: 12px; color: #90a4ae; margin-bottom: 14px; }
  .breadcrumb a { color: #90a4ae; }
  h1 { font-family: 'Sora', 'Segoe UI', Arial, sans-serif; font-size: 24px; margin-bottom: 6px; color: #0f1729; }
  .maj { font-size: 12px; color: #a4b0bd; margin-bottom: 18px; }
  .card { background: #fff; border-radius: 16px; padding: 20px; margin-bottom: 14px; box-shadow: 0 4px 16px rgba(15,23,41,0.07); }
  .chiffres { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  .chip { flex: 1; min-width: 100px; background: #f5f8fb; border: 1px solid #dbe7f5; border-radius: 12px; padding: 10px; text-align: center; }
  .chip-label { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #90a4ae; }
  .chip-value { font-size: 16px; font-weight: 800; color: #1a2433; }
  .total { font-size: 26px; font-weight: 800; color: #1976d2; margin: 12px 0 4px; }
  .verdict { border-radius: 12px; padding: 14px; margin-top: 10px; font-size: 14px; }
  .verdict.eco { background: #e8f5e9; color: #2e7d32; }
  .verdict.non-eco { background: #fdf3e3; color: #8a5a00; }
  .cta { display: block; text-align: center; background: #1976d2; color: #fff; text-decoration: none;
    padding: 14px; border-radius: 12px; font-weight: 700; margin-top: 16px; }
  .faq-item { margin-bottom: 14px; }
  .faq-item h3 { font-size: 15px; margin-bottom: 4px; color: #0f1729; }
  .faq-item p { font-size: 14px; color: #455060; }
  .rel-title { font-size: 16px; margin-bottom: 10px; color: #0f1729; }
  .related { list-style: none; columns: 2; }
  .related li { margin-bottom: 8px; break-inside: avoid; }
  .related a { color: #1976d2; text-decoration: none; font-weight: 600; font-size: 14px; }
  .related a:hover { text-decoration: underline; }
  .rel-all { margin-top: 10px; font-size: 13px; }
  .rel-all a { color: #607080; }
  .src-note { font-size: 11px; color: #a4b0bd; margin-top: 14px; }
  footer { text-align: center; margin-top: 20px; font-size: 12px; }
  footer a { color: #607080; }
</style>
</head>
<body>
<div class="page">
  <div class="breadcrumb"><a href="${SITE_URL}/">Futéroute</a> › <a href="./">Trajets</a> › ${t.depart} → ${t.arrivee}</div>
  <h1>${t.depart} → ${t.arrivee} : coût du trajet en voiture</h1>
  <div class="maj">Chiffres mis à jour le ${dateMaj} · estimation, hors trafic</div>

  <div class="card">
    <div class="chiffres">
      <div class="chip"><div class="chip-label">Distance</div><div class="chip-value">${fmtKm(r.distanceKm)}</div></div>
      <div class="chip"><div class="chip-label">Durée</div><div class="chip-value">${fmtDuree(r.dureeSec)}</div></div>
    </div>
    <div class="chiffres">
      <div class="chip"><div class="chip-label">Carburant (SP95)</div><div class="chip-value">${fmtEur(r.coutCarburant)}</div></div>
      <div class="chip"><div class="chip-label">Péages</div><div class="chip-value">${typeof r.coutPeage === 'number' ? fmtEur(r.coutPeage) : 'n.c.'}</div></div>
    </div>
    <div class="total">${fmtEur(totalRapide)} au total</div>
    ${verdict ? `<div class="verdict ${verdict.rentable ? 'eco' : 'non-eco'}">${verdict.rentable ? '💰' : '🛣️'} ${verdict.texte}</div>` : ''}
    <a class="cta" href="${appUrl}">Recalculer avec ma voiture (aller-retour, autre carburant, étapes…)</a>
    <div class="src-note">Carburant : moyenne France, prix du jour (data.gouv.fr). Péages : tarifs officiels des concessionnaires, classe 1 (voiture).</div>
  </div>

  <div class="card">
    ${faq}
  </div>
${relatedHtml}
  <footer><a href="${SITE_URL}/">← Retour à Futéroute</a></footer>
</div>
</body>
</html>
`;
}

function renderIndex(reussis) {
  const items = reussis.map(t => `<li><a href="./${t.slug}.html">${t.depart} → ${t.arrivee}</a></li>`).join('\n');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Coût des trajets en voiture : carburant, péages | Futéroute</title>
<meta name="description" content="Coût détaillé (carburant + péages) des trajets les plus recherchés en France, avec comparaison éviter/prendre les péages.">
<link rel="canonical" href="${SITE_URL}/trajets/">
<link rel="icon" href="../favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="96x96" href="../favicon.png">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #eef2f6; color: #1a2433; padding: 24px 16px; }
  .page { max-width: 640px; margin: 0 auto; }
  .breadcrumb { font-size: 12px; color: #90a4ae; margin-bottom: 14px; }
  .breadcrumb a { color: #90a4ae; }
  h1 { font-size: 22px; margin-bottom: 16px; color: #0f1729; }
  .card { background: #fff; border-radius: 16px; padding: 20px; box-shadow: 0 4px 16px rgba(15,23,41,0.07); }
  ul { list-style: none; columns: 2; gap: 8px; }
  li { margin-bottom: 10px; break-inside: avoid; }
  a { color: #1976d2; text-decoration: none; font-weight: 600; font-size: 14px; }
  a:hover { text-decoration: underline; }
  footer { text-align: center; margin-top: 20px; font-size: 12px; }
  footer a { color: #607080; }
</style>
</head>
<body>
<div class="page">
  <div class="breadcrumb"><a href="${SITE_URL}/">Futéroute</a> › Trajets</div>
  <h1>Coût des trajets en voiture</h1>
  <div class="card"><ul>${items}</ul></div>
  <footer><a href="${SITE_URL}/">← Retour à Futéroute</a></footer>
</div>
</body>
</html>
`;
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const outDir = path.join(ROOT, 'trajets');

  // Passe 1 : calcule les chiffres réels de chaque trajet (accès réseau).
  const reussis = [];
  for (const t of TRAJETS) {
    process.stdout.write(`Calcul ${t.depart} → ${t.arrivee}… `);
    try {
      const r = await calculerTrajet(browser, t.depart, t.arrivee);
      reussis.push({ ...t, r });
      console.log('ok');
    } catch (e) {
      console.log('ÉCHEC :', e.message);
    }
  }
  await browser.close();
  server.close();

  // Passe 2 : rend les pages avec le maillage interne (liens vers les autres
  // trajets réussis uniquement). Deux passes pour n'avoir aucun lien mort.
  const urls = [];
  for (const t of reussis) {
    fs.writeFileSync(path.join(outDir, `${t.slug}.html`), renderPage(t, t.r, reussis));
    urls.push(`${SITE_URL}/trajets/${t.slug}.html`);
  }
  fs.writeFileSync(path.join(outDir, 'index.html'), renderIndex(reussis));
  urls.push(`${SITE_URL}/trajets/`);

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc><changefreq>weekly</changefreq></url>
${urls.map(u => `  <url><loc>${u}</loc><changefreq>weekly</changefreq></url>`).join('\n')}
</urlset>
`;
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap);
  console.log(`\n${urls.length}/${TRAJETS.length} pages générées. sitemap.xml mis à jour.`);
}

main();
