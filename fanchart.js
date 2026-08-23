/* FanChart — rendu SVG d'un arbre d'ascendants « en éventail » (demi-cercle,
   la personne racine au centre, chaque génération formant un anneau plus
   large). Pensé pour l'impression : texte radial (le long du rayon, pas le
   long de l'arc) pour rester lisible même quand les quartiers deviennent
   très étroits en profondeur — voir pickGenerationCount ci-dessous.
   Aucune dépendance externe (mais suppose Store déjà chargé). */
(function (global) {
  'use strict';

  var MAX_RADIUS = 560;   // rayon externe du dernier anneau
  var R0 = 60;             // rayon interne du premier anneau (= rayon de la pastille racine + marge)
  var MIN_FONT = 9;        // en dessous, plus lisible du tout à l'impression : sert de plancher au calcul du nombre de générations
  var MAX_FONT = 15;
  var SAFETY = 0.72;       // marge sous l'espace perpendiculaire théorique (dépassement réel des glyphes — ascendantes/descendantes)
  var HARD_GEN_CEILING = 10; // jamais dépassé même si les données vont plus loin (générosité inutile)

  function svgEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  // Profondeur réelle d'ascendants connus depuis rootId — même principe que
  // app.js:realGenDepth (protection anti-cycle PAR CHEMIN, pas un set
  // global, pour ne pas sous-compter une branche qui recroise un ancêtre
  // commun par un autre chemin — mariage entre cousins).
  function ancestorDepth(state, rootId) {
    var maxSeen = 0;
    function rec(id, depth, path) {
      if (!id || !state.persons[id]) return;
      maxSeen = Math.max(maxSeen, depth);
      if (path[id]) return;
      path[id] = true;
      (state.persons[id].parentIds || []).forEach(function (pid) { rec(pid, depth + 1, path); });
      delete path[id];
    }
    rec(rootId, 0, {});
    return maxSeen;
  }

  // Espace perpendiculaire disponible au bord interne du dernier anneau, pour
  // un nombre de générations candidat — c'est le point le plus serré du
  // graphique (le plus de quartiers, le rayon le plus petit pour ce niveau).
  function tightestSpace(g) {
    var ringWidth = (MAX_RADIUS - R0) / g;
    var innerR = R0 + (g - 1) * ringWidth;
    var angleWidthRad = Math.PI / Math.pow(2, g);
    return innerR * angleWidthRad * SAFETY;
  }

  // « Le plus de générations possible tant que c'est lisible » : dérivé
  // géométriquement (pas une constante choisie au jugé) — on redescend tant
  // que l'espace le plus serré ne permet même pas la taille de police
  // plancher.
  function pickGenerationCount(realDepth) {
    var candidate = Math.min(Math.max(realDepth, 1), HARD_GEN_CEILING);
    while (candidate > 1 && tightestSpace(candidate) < MIN_FONT) candidate--;
    return candidate;
  }

  function polar(cx, cy, r, angleDeg) {
    var rad = angleDeg * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
  }

  function sectorPath(cx, cy, innerR, outerR, aStart, aEnd) {
    var p1 = polar(cx, cy, outerR, aStart);
    var p2 = polar(cx, cy, outerR, aEnd);
    var p3 = polar(cx, cy, innerR, aEnd);
    var p4 = polar(cx, cy, innerR, aStart);
    var largeArc = (aStart - aEnd) > 180 ? 1 : 0;
    return 'M' + p1.x + ',' + p1.y +
      ' A' + outerR + ',' + outerR + ' 0 ' + largeArc + ' 0 ' + p2.x + ',' + p2.y +
      ' L' + p3.x + ',' + p3.y +
      ' A' + innerR + ',' + innerR + ' 0 ' + largeArc + ' 1 ' + p4.x + ',' + p4.y +
      ' Z';
  }

  function truncate(str, maxChars) {
    if (!str) return '';
    return str.length > maxChars ? str.slice(0, Math.max(1, maxChars - 1)) + '…' : str;
  }

  function birthDeathYears(p) {
    var b = p.naissance && p.naissance.date ? p.naissance.date.slice(0, 4) : '';
    var d = p.deces && p.deces.date ? p.deces.date.slice(0, 4) : (p.decede ? '✝' : '');
    return (b || d) ? (b + (d ? '–' + d : '')) : '';
  }

  // Les deux parents stockés dans parentIds ne sont PAS garantis dans l'ordre
  // père/mère : le slot dépend de l'ordre d'ajout (voir app.js:addParentFlow),
  // pas du sexe. On les réordonne par sexe quand les deux sont connus et
  // différents, pour que chaque lignée (paternelle/maternelle) reste du même
  // côté du graphique sur toute sa profondeur. À défaut, ordre de stockage.
  function orderedParents(state, p) {
    var parents = (p.parentIds || []).map(function (id) { return state.persons[id]; }).filter(Boolean);
    if (parents.length === 2) {
      var father = null, mother = null;
      parents.forEach(function (x) { if (x.sexe === 'H') father = x; else if (x.sexe === 'F') mother = x; });
      if (father && mother && father !== mother) return [father, mother];
    }
    return parents;
  }

  // Texte radial : oriente chaque étiquette le long de son rayon. Dans la
  // moitié droite (0-90°), le texte pointe vers l'extérieur (loin du
  // centre) ; dans la moitié gauche (90-180°), le tourner de 180° de plus
  // évite qu'il se lise à l'envers (sinon la rotation « vers l'extérieur »
  // pure inverse aussi les caractères) — technique standard pour les
  // graphiques radiaux/sunburst.
  function radialRotation(angleDeg) {
    return angleDeg <= 90 ? -angleDeg : 180 - angleDeg;
  }

  function render(svg, state, rootId, opts) {
    opts = opts || {};
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var root = state.persons[rootId];
    if (!root) return { generations: 0, realDepth: 0 };

    var realDepth = ancestorDepth(state, rootId);
    var G = pickGenerationCount(realDepth);
    var ringWidth = (MAX_RADIUS - R0) / G;

    var cx = MAX_RADIUS + 30, cy = MAX_RADIUS + 40;
    svg.setAttribute('viewBox', '0 0 ' + (cx * 2) + ' ' + (MAX_RADIUS + 90));

    var slots = [{ person: root }];
    for (var g = 1; g <= G; g++) {
      var n = Math.pow(2, g);
      var angleStep = 180 / n;
      var innerR = R0 + (g - 1) * ringWidth;
      var outerR = R0 + g * ringWidth;
      var angleWidthRad = angleStep * Math.PI / 180;
      var fs = Math.max(MIN_FONT, Math.min(MAX_FONT, innerR * angleWidthRad * SAFETY));
      var maxChars = Math.max(3, Math.floor((outerR - innerR - 6) / (fs * 0.52)));
      var nextSlots = [];
      for (var i = 0; i < n; i++) {
        var parentSlot = slots[Math.floor(i / 2)];
        var person = (parentSlot && parentSlot.person) ? (orderedParents(state, parentSlot.person)[i % 2] || null) : null;
        var aStart = 180 - i * angleStep;
        var aEnd = 180 - (i + 1) * angleStep;
        var sexe = person ? person.sexe : null;
        var cls = 'fan-wedge' + (sexe === 'H' || sexe === 'F' ? ' sexe-' + sexe : '') + (person ? '' : ' fan-wedge-empty');
        svg.appendChild(svgEl('path', { class: cls, d: sectorPath(cx, cy, innerR, outerR, aStart, aEnd) }));

        if (person) {
          var midAngle = (aStart + aEnd) / 2;
          var midR = (innerR + outerR) / 2;
          var pt = polar(cx, cy, midR, midAngle);
          var label = truncate(Store.fullName(person), maxChars);
          var years = birthDeathYears(person);
          var t = svgEl('text', {
            class: 'fan-label' + (sexe === 'H' || sexe === 'F' ? ' sexe-' + sexe : ''),
            x: pt.x.toFixed(1), y: pt.y.toFixed(1),
            'font-size': fs.toFixed(1),
            'text-anchor': 'middle',
            transform: 'rotate(' + radialRotation(midAngle).toFixed(1) + ' ' + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1) + ')'
          });
          if (years && outerR - innerR > fs * 2.4) {
            var t1 = svgEl('tspan', { x: pt.x.toFixed(1), dy: '-0.35em' }); t1.textContent = label;
            var t2 = svgEl('tspan', { x: pt.x.toFixed(1), dy: '1.1em' }); t2.textContent = years;
            t.appendChild(t1); t.appendChild(t2);
          } else {
            t.textContent = label + (years ? ' ' + years : '');
          }
          svg.appendChild(t);
        }
        nextSlots.push({ person: person });
      }
      slots = nextSlots;
    }

    // Racine, au centre.
    var rootR = R0 - 6;
    var rootSexe = root.sexe === 'H' || root.sexe === 'F' ? root.sexe : null;
    svg.appendChild(svgEl('circle', { class: 'fan-root' + (rootSexe ? ' sexe-' + rootSexe : ''), cx: cx, cy: cy, r: rootR }));
    var rootYears = birthDeathYears(root);
    var rt = svgEl('text', { class: 'fan-root-label', x: cx, y: cy + (rootYears ? -3 : 4), 'text-anchor': 'middle' });
    rt.textContent = truncate(Store.fullName(root), 16);
    svg.appendChild(rt);
    if (rootYears) {
      var ry = svgEl('text', { class: 'fan-root-years', x: cx, y: cy + 14, 'text-anchor': 'middle' });
      ry.textContent = rootYears;
      svg.appendChild(ry);
    }

    return { generations: G, realDepth: realDepth };
  }

  global.FanChart = { render: render, ancestorDepth: ancestorDepth, pickGenerationCount: pickGenerationCount };
})(window);
