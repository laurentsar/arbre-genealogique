# 🌳 Arbre généalogique

Application web indépendante (PWA) pour gérer un arbre généalogique :
personnes, unions, ascendants/descendants.

Tout reste **en local sur l'appareil** (stockage `localStorage` du
navigateur) : aucune donnée n'est envoyée à un serveur.

## Liens

- 🌐 **Version web** : <https://laurentsar.github.io/arbre-genealogique/>
- 📱 **APK Android** : [dernière release](https://github.com/laurentsar/arbre-genealogique/releases/latest)

Les deux sont produits automatiquement à chaque `push` sur `main` et portent
le même numéro de version (`package.json`) : la page web
([`deploy-pages.yml`](.github/workflows/deploy-pages.yml)) et l'APK signé
([`build-apk.yml`](.github/workflows/build-apk.yml)) restent donc toujours
synchronisés sur la même source.

## Synchronisation multi-appareils (facultatif)

L'app fonctionne 100 % en local par défaut. Pour partager le même arbre entre
plusieurs appareils, on la relie à une instance **Home Assistant** (qui stocke
un blob **chiffré** — clé dérivée d'un mot de passe famille, AES-GCM).

Aucun secret n'est embarqué dans le build : la config est saisie **à
l'exécution** (modèle inspiré de l'app *gesthote*).

1. Installe l'APK (ou ouvre la page servie par HA), appuie sur le bouton
   flottant **☁** en bas à gauche.
2. Renseigne l'**URL Home Assistant** (ex. `https://xxxxx.ui.nabu.casa`) et
   l'**identifiant du webhook** (`genealogie_…`), puis *Enregistrer et tester*.
3. Saisis le **mot de passe famille** au premier échange chiffré.

Côté HA : un `webhook` → `shell_command` écrit `www/genealogie/data/tree.json`
(voir le dépôt Home Assistant). Sur la page **servie par HA**, la config est
déjà fournie (URLs relatives, même origine) : pas de bouton ☁, ça marche seul.
Depuis un navigateur externe (github.io) la synchro est bloquée par le **CORS** ;
utilise l'APK (requêtes natives) ou la page servie par HA.

## Fonctionnalités

- **Personnes** : fiche par personne (nom, sexe, naissance, décès, notes),
  recherche.
- **Liens de parenté** : parents, conjoint(s), enfants, frères et sœurs —
  gérés depuis la fiche de chaque personne.
- **Arbre visuel** : vue Ascendants (jusqu'à 7 générations) ou Descendants,
  centrée sur la personne de son choix, avec glisser pour déplacer et
  molette/boutons pour zoomer.
- **Sauvegarde** : export/import au format JSON (sauvegarde complète) et au
  format **GEDCOM** (standard d'échange, compatible Geneanet, Heredis,
  Gramps…).
- **PWA installable**, utilisable hors-ligne une fois chargée.

## Utilisation

Aucune dépendance ni étape de build : ce sont des fichiers statiques.

```sh
python3 -m http.server 8000
# puis ouvrir http://localhost:8000/index.html
```

Les icônes de l'app (`img/icon-*.png`) sont générées par
`tools_gen_icon.py` (aucune dépendance externe requise).
