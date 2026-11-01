/* Tree — rendu SVG de l'arbre (ascendants et descendants), avec
   pan (glisser) et zoom (molette / boutons). Aucune dépendance externe.
   Style inspiré des arbres généalogiques « à pastilles » : personnes en
   cercles, point d'union entre conjoints, ligne d'union vers les enfants. */
(function (global) {
  'use strict';

  var R = 34;          // rayon des cercles-personnes
  var DOT_R = 6;        // rayon du point d'union
  var COL_W = 230;       // ascendants : largeur d'une colonne (une génération)
  var ROW_UNIT = 124;     // ascendants : hauteur réservée par personne
  var UNIT_W = 230;      // descendants : largeur réservée par personne (branche)
  var GEN_H = 190;       // descendants : hauteur entre deux générations
  var SPOUSE_DX = 112;    // descendants : décalage horizontal conjoint

  function svgEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function initials(p) {
    var a = (p.prenom || '').charAt(0);
    var b = (p.nom || '').charAt(0);
    return (a + b).toUpperCase() || '?';
  }

  // Année d'une date quel que soit son format (ISO « 1985-04-12 », saisie
  // « 12/04/1985 », GEDCOM « ABT 1850 », « vers 1850 ») : la 1re suite de
  // 4 chiffres. `slice(0, 4)` affichait « 12/0 » pour une date JJ/MM/AAAA.
  function yearOf(date) {
    var m = /(\d{4})/.exec(String(date || ''));
    return m ? m[1] : '';
  }

  function label(p) {
    var name = Store.fullName(p);
    var b = p.naissance ? yearOf(p.naissance.date) : '';
    var dy = p.deces ? yearOf(p.deces.date) : '';
    var d = (p.decede || dy) ? (dy || '✝') : '';
    var years = (b || d) ? (b + (d ? ' – ' + d : (p.decede ? ' – ✝' : ''))) : '';
    // Âge quand calculable (voir Store.computeAge) : ajouté entre
    // parenthèses à la suite des années, sans rien changer si indisponible.
    var ageInfo = Store.computeAge(p);
    if (ageInfo) years += (years ? ' ' : '') + '(' + ageInfo.age + ' ans)';
    return { name: name, years: years };
  }

  function drawDot(group, x, y) {
    group.appendChild(svgEl('circle', { class: 'tree-dot', cx: x, cy: y, r: DOT_R }));
  }

  function approxTextWidth(str, fs) { return (str || '').length * fs * 0.58; }

  var NAME_FS = 18;
  var YEARS_FS = 13;

  // Largeur du bandeau nom+années — partagée entre le dessin (drawPerson) et
  // le calcul d'espacement conjoint (renderDescendants), pour que l'un ne
  // puisse jamais empiéter sur l'autre : voir dispName/nameW ci-dessous.
  // Tient compte des DEUX lignes (nom ET années, ex. avec l'âge ajouté :
  // « 1879 – 1965 (85 ans) » peut être plus large que le nom lui-même).
  function boxWidth(p) {
    var info = label(p);
    var dispName = info.name.length > 26 ? info.name.slice(0, 25) + '…' : info.name;
    var w = Math.max(approxTextWidth(dispName, NAME_FS), info.years ? approxTextWidth(info.years, YEARS_FS) : 0);
    return Math.max(w + 20, R * 1.8);
  }

  function drawPerson(group, id, p, cx, cy, opts, isRoot, isSpouse, hasHidden) {
    var cls = 'tree-node sexe-' + (p.sexe || '?');
    if (isRoot) cls += ' is-root';
    if (isSpouse) cls += ' is-spouse';
    if (hasHidden) cls += ' has-hidden';
    if (opts.selectedId === id) cls += ' is-selected';
    var g = svgEl('g', { class: cls, transform: 'translate(' + cx + ',' + cy + ')', 'data-id': id });
    // Halo de sélection (visible seulement avec .is-selected, voir CSS)
    g.appendChild(svgEl('circle', { class: 'tree-select-ring', r: R + 7 }));

    // Pastille + photo (si présente) ou initiales
    g.appendChild(svgEl('circle', { class: 'tree-avatar', r: R }));
    var photo = global.GenUtil && global.GenUtil.validPhoto ? global.GenUtil.validPhoto(p.photo) : '';
    if (photo) {
      var img = svgEl('image', {
        class: 'tree-photo', x: -R, y: -R, width: R * 2, height: R * 2,
        preserveAspectRatio: 'xMidYMid slice', 'clip-path': 'url(#treePhotoClip)'
      });
      img.setAttribute('href', photo);
      g.appendChild(img);
      // Liseré par-dessus la photo (couleur du sexe / racine / sélection)
      g.appendChild(svgEl('circle', { class: 'tree-avatar tree-avatar-ring', r: R }));
    } else {
      var initEl = svgEl('text', { class: 'tree-initials', 'text-anchor': 'middle', dy: '0.34em' });
      initEl.textContent = initials(p);
      g.appendChild(initEl);
    }

    // Nom (agrandi) sur un bandeau pour rester lisible sur le fond sombre
    var info = label(p);
    var dispName = info.name.length > 26 ? info.name.slice(0, 25) + '…' : info.name;
    var nameW = boxWidth(p);
    var nameY = R + 10;
    g.appendChild(svgEl('rect', { class: 'tree-name-bg', x: -nameW / 2, y: nameY, width: nameW, height: 26, rx: 12 }));
    var nameEl = svgEl('text', { class: 'tree-name', 'text-anchor': 'middle', y: nameY + 18 });
    nameEl.textContent = dispName;
    g.appendChild(nameEl);
    if (info.years) {
      var yearsEl = svgEl('text', { class: 'tree-years', 'text-anchor': 'middle', y: nameY + 36 });
      yearsEl.textContent = info.years;
      g.appendChild(yearsEl);
    }

    // Clic = onSelect (mobile : recentrer ; PC : sélectionner et afficher la
    // fiche dans le panneau) ; double-clic = onActivate (PC : recentrer ici).
    g.addEventListener('click', function () { if (opts.onSelect) opts.onSelect(id); });
    g.addEventListener('dblclick', function (e) {
      e.preventDefault();
      if (opts.onActivate) opts.onActivate(id);
    });

    // Accessibilité clavier / lecteur d'écran : chaque personne est
    // focalisable (Tab), Entrée recentre, Espace sélectionne, « i » ouvre la fiche.
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', info.name + (info.years ? ', ' + info.years : '') +
      (isRoot ? ' (personne affichée au centre)' : '') + '. Entrée : centrer ici. I : ouvrir la fiche.');
    g.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); (opts.onActivate || opts.onSelect)(id); }
      else if (e.key === ' ') { e.preventDefault(); if (opts.onSelect) opts.onSelect(id); }
      else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); if (opts.onOpen) opts.onOpen(id); }
    });

    // Bouton « i » : ouvrir la fiche détaillée sans recentrer
    var ib = svgEl('g', { class: 'tree-info-btn', transform: 'translate(' + (R * 0.72) + ',' + (-R * 0.72) + ')' });
    ib.appendChild(svgEl('circle', { r: 10 }));
    var ig = svgEl('text', { class: 'tree-info-glyph', 'text-anchor': 'middle', dy: '0.35em' });
    ig.textContent = 'i';
    ib.appendChild(ig);
    ib.addEventListener('click', function (e) { e.stopPropagation(); if (opts.onOpen) opts.onOpen(id); });
    g.appendChild(ib);

    // Pictogramme ♂/♀ : identifie le sexe même sans distinguer la couleur
    // de la pastille (contraste faible entre sexe-H/sexe-F sur petit écran).
    if (p.sexe === 'H' || p.sexe === 'F') {
      var gb = svgEl('g', { class: 'tree-gender-badge sexe-' + p.sexe, transform: 'translate(' + (-R * 0.72) + ',' + (R * 0.72) + ')' });
      gb.appendChild(svgEl('circle', { r: 9 }));
      var gg = svgEl('text', { class: 'tree-gender-glyph', 'text-anchor': 'middle', dy: '0.35em' });
      gg.textContent = p.sexe === 'H' ? '♂' : '♀';
      gb.appendChild(gg);
      g.appendChild(gb);
    }

    // Badge « + » quand des parents/enfants existent mais ne sont pas affichés
    if (hasHidden) {
      var bp = opts.mode === 'descendants' ? { x: 0, y: R } : { x: R, y: 0 };
      var eb = svgEl('g', { class: 'tree-expand-btn', transform: 'translate(' + bp.x + ',' + bp.y + ')' });
      eb.appendChild(svgEl('circle', { r: 9 }));
      var eg = svgEl('text', { class: 'tree-expand-glyph', 'text-anchor': 'middle', dy: '0.35em' });
      eg.textContent = '+';
      eb.appendChild(eg);
      eb.addEventListener('click', function (e) { e.stopPropagation(); (opts.onActivate || opts.onSelect)(id); });
      g.appendChild(eb);
    }
    group.appendChild(g);
  }

  // Emplacement vide « + Père / + Mère / + Enfant » : pastille en pointillés
  // à la place d'un parent ou d'un enfant manquant de la personne au centre.
  // Clic = choisir une personne existante ou en créer une (opts.onAdd).
  function drawGhost(group, n, opts) {
    var text = n.role === 'child' ? 'Enfant' : (n.sexe === 'H' ? 'Père' : 'Mère');
    var g = svgEl('g', { class: 'tree-ghost', transform: 'translate(' + n.cx + ',' + n.cy + ')' });
    g.appendChild(svgEl('circle', { class: 'tree-ghost-circle', r: R * 0.8 }));
    var plus = svgEl('text', { class: 'tree-ghost-plus', 'text-anchor': 'middle', dy: '0.35em' });
    plus.textContent = '+';
    g.appendChild(plus);
    var lbl = svgEl('text', { class: 'tree-ghost-label', 'text-anchor': 'middle', y: R * 0.8 + 22 });
    lbl.textContent = 'Ajouter ' + (n.role === 'child' ? 'un enfant' : (n.sexe === 'H' ? 'le père' : 'la mère'));
    g.appendChild(lbl);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', '+ ' + text);
    function fire() { if (opts.onAdd) opts.onAdd(n.role, n.ownerId, n.sexe || null); }
    g.addEventListener('click', function (e) { e.stopPropagation(); fire(); });
    g.addEventListener('dblclick', function (e) { e.stopPropagation(); });
    g.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
    });
    group.appendChild(g);
  }

  // --- Ascendants (numérotation d'Ahnentafel : 1=racine, 2n=père, 2n+1=mère) ---

  function buildAncestors(state, rootId, maxGen, ghostFor) {
    // Layout COMPACT : au lieu de réserver 2^génération lignes (grille
    // d'Ahnentafel pleine, vide à 99 % dès qu'il manque des ancêtres, ce qui
    // forçait un dézoom illisible), on empile seulement les ancêtres RÉELS.
    // Chaque feuille prend une ligne ; chaque personne est centrée verticalement
    // sur ses parents. Résultat : aucune place perdue, texte lisible.
    var nodes = [];
    var byKey = {};
    var leafCursor = 0;
    // `path` = ancêtres déjà présents sur la lignée en cours. Empêche une boucle
    // (une personne désignée comme son propre ancêtre) de se dérouler à l'infini
    // dans la limite des générations : on dessine la personne mais on ne remonte
    // pas au-dessus d'elle une seconde fois.
    function rec(id, gen, slot, path) {
      if (!id || gen > maxGen) return null;
      var p = state.persons[id];
      var n = { id: id, gen: gen, slot: slot, cx: gen * COL_W + R };
      nodes.push(n);
      byKey[gen + '_' + slot] = n;
      var cycle = !!path[id];
      var parents = (gen < maxGen && p && !cycle) ? (p.parentIds || []) : [];
      path[id] = true;
      var father = parents[0] ? rec(parents[0], gen + 1, slot * 2, path) : null;
      var mother = parents[1] ? rec(parents[1], gen + 1, slot * 2 + 1, path) : null;
      // Parents manquants de la personne au centre : emplacements « + » (le
      // 1er parent enregistré occupe la place du père, cf. setParent).
      if (id === ghostFor && gen < maxGen && p && !cycle) {
        var known = parents.map(function (pid) { return state.persons[pid]; }).filter(Boolean);
        if (known.length === 0) {
          father = ghost(gen + 1, slot * 2, 'H', id);
          mother = ghost(gen + 1, slot * 2 + 1, 'F', id);
        } else if (known.length === 1) {
          var other = known[0].sexe === 'F' ? 'H' : 'F';
          if (!father) father = ghost(gen + 1, slot * 2, other, id);
          else if (!mother) mother = ghost(gen + 1, slot * 2 + 1, other, id);
        }
      }
      delete path[id];
      var kids = [father, mother].filter(Boolean);
      if (!kids.length) {
        n.cy = (leafCursor + 0.5) * ROW_UNIT;
        leafCursor += 1;
      } else {
        n.cy = kids.reduce(function (s, k) { return s + k.cy; }, 0) / kids.length;
      }
      return n;
    }
    function ghost(gen, slot, sexe, ownerId) {
      var n = { ghost: true, role: 'parent', sexe: sexe, ownerId: ownerId, gen: gen, slot: slot, cx: gen * COL_W + R };
      n.cy = (leafCursor + 0.5) * ROW_UNIT;
      leafCursor += 1;
      nodes.push(n);
      byKey[gen + '_' + slot] = n;
      return n;
    }
    rec(rootId, 0, 0, {});
    var maxGenSeen = nodes.reduce(function (m, n) { return Math.max(m, n.gen); }, 0);
    var height = Math.max(leafCursor, 1) * ROW_UNIT;
    return {
      nodes: nodes, byKey: byKey, maxGen: maxGenSeen,
      width: (maxGenSeen + 1) * COL_W + R, height: height
    };
  }

  function renderAncestors(nodesGroup, edgesGroup, state, data, rootId, opts, maxGen) {
    data.nodes.forEach(function (n) {
      if (n.ghost) { drawGhost(nodesGroup, n, opts); return; }
      var p = state.persons[n.id];
      if (!p) return;
      var parents = p.parentIds || [];
      var hasHidden = n.gen === maxGen && !!(parents[0] || parents[1]);
      drawPerson(nodesGroup, n.id, p, n.cx, n.cy, opts, n.id === rootId, false, hasHidden);
    });

    for (var gen = 1; gen <= data.maxGen; gen++) {
      var couples = Math.pow(2, gen - 1);
      for (var k = 0; k < couples; k++) {
        var child = data.byKey[(gen - 1) + '_' + k];
        var a = data.byKey[gen + '_' + (2 * k)];
        var b = data.byKey[gen + '_' + (2 * k + 1)];
        if (!child) continue;
        if (a && b) {
          var dotX = a.cx - COL_W / 2;
          var dotY = (a.cy + b.cy) / 2;
          drawDot(edgesGroup, dotX, dotY);
          edgesGroup.appendChild(svgEl('path', {
            class: 'tree-edge tree-edge-union' + (a.ghost ? ' tree-edge-ghost' : ''),
            d: 'M ' + dotX + ' ' + dotY + ' V ' + a.cy + ' H ' + (a.cx - R)
          }));
          edgesGroup.appendChild(svgEl('path', {
            class: 'tree-edge tree-edge-union' + (b.ghost ? ' tree-edge-ghost' : ''),
            d: 'M ' + dotX + ' ' + dotY + ' V ' + b.cy + ' H ' + (b.cx - R)
          }));
          edgesGroup.appendChild(svgEl('path', {
            class: 'tree-edge tree-edge-child' + (a.ghost && b.ghost ? ' tree-edge-ghost' : ''),
            d: 'M ' + (child.cx + R) + ' ' + child.cy + ' H ' + dotX + ' V ' + dotY
          }));
        } else {
          var single = a || b;
          if (!single) continue;
          var midX = (child.cx + R + single.cx - R) / 2;
          edgesGroup.appendChild(svgEl('path', {
            class: 'tree-edge tree-edge-child' + (single.ghost ? ' tree-edge-ghost' : ''),
            d: 'M ' + (child.cx + R) + ' ' + child.cy + ' H ' + midX + ' V ' + single.cy + ' H ' + (single.cx - R)
          }));
        }
      }
    }
  }

  // --- Descendants (tidy tree : largeur de sous-arbre en "unités") ---

  var GHOST_CHILD = '__ghost_child__';

  function buildDescendants(state, rootId, maxGen, ghostFor) {
    var positions = {};
    var edges = [];
    var visited = {};

    function width(id, gen) {
      if (visited[id] || gen >= maxGen) return 1;
      visited[id] = true;   // déduplique comme assign() : un même individu n'est compté qu'une fois
      var children = Store.getChildren(state, id);
      var extra = (id === ghostFor) ? 1 : 0;   // emplacement « + Enfant »
      if (!children.length && !extra) return 1;
      var w = extra;
      children.forEach(function (c) { w += width(c.id, gen + 1); });
      return Math.max(w, 1);
    }

    function assign(id, xStart, gen) {
      visited[id] = true;
      if (id === GHOST_CHILD) {
        positions[id] = { gen: gen, x: xStart + 0.5, ghost: true };
        return xStart + 1;
      }
      var children = gen < maxGen ? Store.getChildren(state, id) : [];
      if (id === ghostFor && gen < maxGen) children = children.concat([{ id: GHOST_CHILD }]);
      var x;
      if (!children.length) {
        x = xStart + 0.5;
        positions[id] = { gen: gen, x: x };
        return xStart + 1;
      }
      var curX = xStart;
      var centers = [];
      children.forEach(function (c) {
        edges.push({ from: id, to: c.id });
        var next = assign(c.id, curX, gen + 1);
        centers.push((curX + next) / 2);
        curX = next;
      });
      x = (centers[0] + centers[centers.length - 1]) / 2;
      positions[id] = { gen: gen, x: x };
      return curX;
    }

    var totalUnits = width(rootId, 0);
    visited = {};
    assign(rootId, 0, 0);

    var nodes = Object.keys(positions).map(function (id) {
      var pos = positions[id];
      var n = { id: id, gen: pos.gen, cx: pos.x * UNIT_W, cy: pos.gen * GEN_H + R };
      if (pos.ghost) { n.ghost = true; n.role = 'child'; n.ownerId = ghostFor; }
      return n;
    });
    var maxGenSeen = nodes.reduce(function (m, n) { return Math.max(m, n.gen); }, 0);
    // Marge droite du cadre : le plus grand écart conjoint réellement utilisé
    // (voir renderDescendants) peut dépasser SPOUSE_DX pour des noms longs —
    // sous-estimer ici resserrerait le cadrage automatique au point de
    // rogner visuellement le dernier conjoint affiché.
    var rightMargin = SPOUSE_DX;
    nodes.forEach(function (n) {
      var p = n.ghost ? null : state.persons[n.id];
      var spouses = p ? Store.getSpouses(state, n.id) : [];
      if (spouses.length) {
        rightMargin = Math.max(rightMargin, boxWidth(p) / 2 + boxWidth(spouses[0]) / 2 + 16);
      }
    });
    return {
      nodes: nodes, edges: edges,
      width: totalUnits * UNIT_W + rightMargin,
      height: (maxGenSeen + 1) * GEN_H
    };
  }

  function renderDescendants(nodesGroup, edgesGroup, state, data, rootId, opts, maxGen) {
    var byId = {};
    data.nodes.forEach(function (n) { byId[n.id] = n; });

    // Écart réellement nécessaire entre une personne et son 1er conjoint pour
    // que leurs bandeaux nom+années ne se chevauchent jamais, quelle que soit
    // la longueur des noms (plancher = SPOUSE_DX, l'espacement habituel pour
    // des noms courts). Calculé une seule fois par personne, réutilisé pour
    // le point d'union ET pour le positionnement du conjoint plus bas.
    var spouseDx = {};
    function spouseGap(id, sp) {
      if (spouseDx[id] === undefined) {
        var p = state.persons[id];
        spouseDx[id] = Math.max(SPOUSE_DX, boxWidth(p) / 2 + boxWidth(sp) / 2 + 16);
      }
      return spouseDx[id];
    }

    // Point d'union par personne : soit entre elle et son 1er conjoint,
    // soit juste sous elle si aucun conjoint n'est enregistré.
    var unionPoint = {};
    data.nodes.forEach(function (n) {
      if (n.ghost) return;
      var spouses = Store.getSpouses(state, n.id);
      if (spouses.length) {
        unionPoint[n.id] = { x: n.cx + spouseGap(n.id, spouses[0]) / 2, y: n.cy, spouse: spouses[0] };
      } else {
        unionPoint[n.id] = { x: n.cx, y: n.cy + R + 44 };
      }
    });

    data.edges.forEach(function (e) {
      var a = byId[e.from], b = byId[e.to];
      if (!a || !b) return;
      var up = unionPoint[a.id];
      var sx = up.x, sy = up.y;
      var ex = b.cx, ey = b.cy - R;
      if (b.ghost) ey = b.cy - R * 0.8;
      // Barre horizontale sous les étiquettes nom + années du parent (au
      // milieu, elle barrait la ligne des années).
      var midY = Math.max((sy + ey) / 2, a.cy + R + 56);
      var d = 'M ' + sx + ' ' + sy + ' V ' + midY + ' H ' + ex + ' V ' + ey;
      edgesGroup.appendChild(svgEl('path', { d: d, class: 'tree-edge tree-edge-child' + (b.ghost ? ' tree-edge-ghost' : '') }));
    });

    data.nodes.forEach(function (n) {
      if (n.ghost) { drawGhost(nodesGroup, n, opts); return; }
      var p = state.persons[n.id];
      if (!p) return;
      var up = unionPoint[n.id];
      // TOUS les conjoints (remariages inclus) — avant, seul le 1er était affiché,
      // les autres et leurs enfants apparaissaient sans parent.
      var spouses = Store.getSpouses(state, n.id);
      if (spouses.length) {
        var prevX = n.cx;
        var dx = spouseGap(n.id, spouses[0]);
        spouses.forEach(function (sp, i) {
          var sx = n.cx + dx + i * (R * 2 + 18);
          edgesGroup.appendChild(svgEl('path', {
            class: 'tree-edge tree-edge-union',
            d: 'M ' + (prevX + R) + ' ' + n.cy + ' H ' + (sx - R)
          }));
          drawDot(edgesGroup, (prevX + sx) / 2, n.cy);
          drawPerson(nodesGroup, sp.id, sp, sx, n.cy, opts, false, true, false);
          prevX = sx;
        });
      } else if (Store.getChildren(state, n.id).length || n.id === opts.ghostFor) {
        drawDot(edgesGroup, up.x, up.y);
      }
      var hasHidden = n.gen === maxGen && Store.getChildren(state, n.id).length > 0;
      drawPerson(nodesGroup, n.id, p, n.cx, n.cy, opts, n.id === rootId, false, hasHidden);
    });
  }

  // Les écouteurs (pointeurs, molette) sont posés UNE SEULE FOIS par <svg> :
  // le <svg> est réutilisé d'un rendu à l'autre, et les rattacher à chaque
  // rendu les accumulait (N navigations → N gestionnaires par geste, l'app
  // ralentissait au fil de la session). Seuls le groupe affiché (viewport)
  // et ses dimensions (box) changent à chaque rendu : voir attach().
  function attachPanZoom(svg, viewport, box, keepView) {
    var ctl = svg.__panZoom;
    if (!ctl) { ctl = createPanZoom(svg); svg.__panZoom = ctl; }
    ctl.attach(viewport, box, keepView);
    return ctl;
  }

  function createPanZoom(svg) {
    var state = { scale: 1, tx: 0, ty: 0, dragging: false, lastX: 0, lastY: 0 };
    var viewport = null;
    var box = { width: 1, height: 1 };

    function apply() {
      if (!viewport) return;
      viewport.setAttribute('transform', 'translate(' + state.tx + ',' + state.ty + ') scale(' + state.scale + ')');
    }

    // Cadrage : tout l'arbre s'il tient à une échelle LISIBLE ; sinon on garde
    // une échelle lisible (MIN_READABLE) cadrée sur la personne au centre
    // (box.focus) plutôt que de tout réduire jusqu'à des noms illisibles.
    var MIN_READABLE = 0.55;
    function fit() {
      var rect = svg.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;   // vue masquée : on recadrera au retour
      var w = rect.width, h = rect.height;
      var pad = 40;
      var s = Math.min((w - pad * 2) / box.width, (h - pad * 2) / box.height, 1);
      if (s >= MIN_READABLE || !box.focus) {
        s = Math.max(s, 0.15);
        state.scale = s;
        state.tx = (w - box.width * s) / 2;
        state.ty = (h - box.height * s) / 2;
      } else {
        s = MIN_READABLE;
        state.scale = s;
        if (box.focusMode === 'descendants') {
          state.tx = w / 2 - box.focus.x * s;
          state.ty = pad;
        } else {
          state.tx = pad + 70 * s - box.focus.x * s;
          state.ty = h / 2 - box.focus.y * s;
        }
      }
      state.userMoved = false;
      apply();
    }
    // Recadre au redimensionnement (fenêtre, panneau latéral) tant que
    // l'utilisateur n'a pas lui-même déplacé/zoomé la vue.
    if (typeof ResizeObserver !== 'undefined') {
      var lastW = 0, lastH = 0;
      new ResizeObserver(function () {
        var r = svg.getBoundingClientRect();
        if (Math.abs(r.width - lastW) < 2 && Math.abs(r.height - lastH) < 2) return;
        var wasHidden = lastW < 10 || lastH < 10;
        lastW = r.width; lastH = r.height;
        if (viewport && (!state.userMoved || wasHidden)) fit();
      }).observe(svg);
    }

    // Multi-pointeurs : 1 doigt = déplacer, 2 doigts = pincer pour zoomer
    // (indispensable sur mobile — il n'y avait que la molette et les boutons).
    var pointers = {};
    var pinch = null;   // { dist, mx, my } au dernier relevé

    function pointerList() {
      return Object.keys(pointers).map(function (k) { return pointers[k]; });
    }
    function setScaleAround(newScale, mx, my) {
      newScale = Math.min(Math.max(newScale, 0.1), 3);
      state.tx = mx - (mx - state.tx) * (newScale / state.scale);
      state.ty = my - (my - state.ty) * (newScale / state.scale);
      state.scale = newScale;
      state.userMoved = true;
      apply();
    }
    function zoomCenter(factor) {
      var rect = svg.getBoundingClientRect();
      setScaleAround(state.scale * factor, rect.width / 2, rect.height / 2);
    }

    // Seuil de déplacement avant de considérer un vrai pan. On ne capture PAS le
    // pointeur au pointerdown : sinon le `click` est redirigé vers le SVG au lieu
    // du nœud → à la souris, sélectionner/éditer une personne ne marchait pas.
    // On ne capture qu'une fois le seuil franchi (= vrai glissement).
    var DRAG_THRESHOLD = 5;
    svg.addEventListener('pointerdown', function (e) {
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var pts = pointerList();
      if (pts.length === 1) {
        state.dragging = false;
        state.pendingPan = true;
        state.startX = e.clientX; state.startY = e.clientY;
        state.lastX = e.clientX; state.lastY = e.clientY;
      } else if (pts.length === 2) {
        state.dragging = false; state.pendingPan = false;
        try { svg.setPointerCapture(e.pointerId); } catch (_) {}
        var dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
        pinch = { dist: Math.hypot(dx, dy) || 1 };
      }
    });
    svg.addEventListener('pointermove', function (e) {
      if (!pointers[e.pointerId]) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var pts = pointerList();
      if (pts.length >= 2 && pinch) {
        var dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
        var dist = Math.hypot(dx, dy) || 1;
        var rect = svg.getBoundingClientRect();
        var mx = (pts[0].x + pts[1].x) / 2 - rect.left;
        var my = (pts[0].y + pts[1].y) / 2 - rect.top;
        setScaleAround(state.scale * (dist / pinch.dist), mx, my);
        pinch.dist = dist;
      } else if (pts.length === 1) {
        if (state.pendingPan && !state.dragging) {
          if (Math.hypot(e.clientX - state.startX, e.clientY - state.startY) <= DRAG_THRESHOLD) return;
          state.dragging = true;                       // seuil franchi → vrai pan
          try { svg.setPointerCapture(e.pointerId); } catch (_) {}
        }
        if (state.dragging) {
          state.tx += e.clientX - state.lastX;
          state.ty += e.clientY - state.lastY;
          state.userMoved = true;
          state.lastX = e.clientX; state.lastY = e.clientY;
          apply();
        }
      }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      svg.addEventListener(ev, function (e) {
        delete pointers[e.pointerId];
        var pts = pointerList();
        if (pts.length < 2) pinch = null;
        if (pts.length === 0) { state.dragging = false; state.pendingPan = false; }
        else if (pts.length === 1) {
          state.dragging = true; state.pendingPan = false;
          state.lastX = pts[0].x; state.lastY = pts[0].y;
        }
      });
    });
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var factor = e.deltaY < 0 ? 1.1 : 0.9;
      var rect = svg.getBoundingClientRect();
      setScaleAround(state.scale * factor, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    return {
      // keepView : même racine/mode (ex. sélection, ajout d'un parent) →
      // on conserve le zoom et la position plutôt que de tout recadrer.
      attach: function (vp, b, keepView) {
        viewport = vp; box = b;
        if (keepView && state.userMoved) apply(); else fit();
      },
      zoomIn: function () { zoomCenter(1.2); },
      zoomOut: function () { zoomCenter(1 / 1.2); },
      reset: fit
    };
  }

  function render(svg, state, opts) {
    var mode = opts.mode === 'descendants' ? 'descendants' : 'ancestors';
    var maxGen = opts.maxGen || 4;
    var rootId = opts.rootId;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!rootId || !state.persons[rootId]) return null;

    // Découpe ronde partagée des photos (coordonnées locales de chaque nœud)
    var defs = svgEl('defs', {});
    var clip = svgEl('clipPath', { id: 'treePhotoClip' });
    clip.appendChild(svgEl('circle', { r: R - 1.5 }));
    defs.appendChild(clip);
    svg.appendChild(defs);

    var viewport = svgEl('g', { class: 'tree-viewport' });
    svg.appendChild(viewport);

    var edgesGroup = svgEl('g', { class: 'tree-edges' });
    var nodesGroup = svgEl('g', { class: 'tree-nodes' });
    viewport.appendChild(edgesGroup);
    viewport.appendChild(nodesGroup);

    var data, box;
    if (mode === 'descendants') {
      data = buildDescendants(state, rootId, maxGen, opts.ghostFor);
      renderDescendants(nodesGroup, edgesGroup, state, data, rootId, opts, maxGen);
    } else {
      data = buildAncestors(state, rootId, maxGen, opts.ghostFor);
      renderAncestors(nodesGroup, edgesGroup, state, data, rootId, opts, maxGen);
    }
    box = { width: Math.max(data.width, R * 2), height: Math.max(data.height, R * 2), focusMode: mode };
    data.nodes.forEach(function (n) { if (n.id === rootId) box.focus = { x: n.cx, y: n.cy }; });

    return attachPanZoom(svg, viewport, box, opts.keepView);
  }

  // Met à jour la sélection sans redessiner (évite de recadrer la vue).
  function markSelected(svg, id) {
    Array.prototype.forEach.call(svg.querySelectorAll('.tree-node'), function (g) {
      g.classList.toggle('is-selected', g.getAttribute('data-id') === id);
    });
  }

  global.Tree = { render: render, markSelected: markSelected, yearOf: yearOf };
})(window);
