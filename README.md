# Tratjet

Calculez le vrai coût de vos trajets en voiture : **carburant (ou électricité) + péages**, avec comparaison de l'itinéraire sans péages pour savoir s'il est rentable.

👉 **https://jeanlori-lab.github.io/tratjet/**

## Fonctionnalités

- Coût du trajet : carburant consommé (prix moyens actuels par type de carburant), prix des péages détaillé par tronçon, aller simple ou aller-retour.
- Comparaison **Péages / Sans péages** : temps, kilomètres et économie réelle entre les deux itinéraires.
- Trajets à étapes, avec préconisations tronçon par tronçon des péages rentables à éviter.
- **Station la moins chère** près du départ et sur le trajet (ou borne de recharge la plus proche en électrique), avec optimisation du moment du plein selon le niveau du réservoir.
- Véhicules et trajets favoris mémorisés, **synchronisés entre appareils** via un compte (connexion par lien magique, sans mot de passe).
- Installable en PWA sur mobile.

## Technique

- `index.html` : toute l'application (HTML/CSS/JS, sans build), hébergée sur GitHub Pages.
- `cloudflare-worker-peage.js` : relais Cloudflare Worker pour le calcul des péages (contourne le CORS des APIs Vinci-autoroutes / ViaMichelin).
- `supabase-setup.sql` : table et règles RLS du compte/synchronisation (Supabase).
- Données : BAN (adresses), Photon (points d'intérêt), OpenRouteService (itinéraires), prix des carburants data.gouv.fr, bornes IRVE ODRÉ.
