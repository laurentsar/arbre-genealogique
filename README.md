# 🌳 Arbre généalogique

Application web indépendante (PWA) pour gérer un arbre généalogique :
personnes, unions, ascendants/descendants.

Tout reste **en local sur l'appareil** (stockage `localStorage` du
navigateur) : aucune donnée n'est envoyée à un serveur.

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
