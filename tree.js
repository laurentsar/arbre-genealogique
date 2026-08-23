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

  function label(p) {
    var name = Store.fullName(p);
    var b = p.naissance && p.naissance.date ? p.naissance.date.slice(0, 4) : '';
    var d = p.decede || (p.deces && p.deces.date) ? (p.deces && p.deces.date ? p.deces.date.slice(0, 4) : '✝') : '';
    var years = (b || d) ? (b + (d ? ' – ' + d : (p.decede ? ' – ✝' : ''))) : '';
    return { name: name, years: years };
  }

  function drawDot(group, x, y) {
    group.appendChild(svgEl('circle', { class: 'tree-dot', cx: x, cy: y, r: DOT_R }));
  }

  function approxTextWidth(str, fs) { return (str || '').length * fs * 0.58; }

  function drawPerson(group, id, p, cx, cy, opts, isRoot, isSpouse, hasHidden) {
    var cls = 'tree-node sexe-' + (p.sexe || '?');
    if (isRoot) cls += ' is-root';
    if (isSpouse) cls += ' is-spouse';
    if (hasHidden) cls += ' has-hidden';
    var g = svgEl('g', { class: cls, transform: 'translate(' + cx + ',' + cy + ')' });

    // Pastille + initiales
    g.appendChild(svgEl('circle', { class: 'tree-avatar', r: R }));
    var initEl = svgEl('text', { class: 'tree-initials', 'text-anchor': 'middle', dy: '0.34em' });
    initEl.textContent = initials(p);
    g.appendChild(initEl);

    // Nom (agrandi) sur un bandeau pour rester lisible sur le fond sombre
    var info = label(p);
    var dispName = info.name.length > 26 ? info.name.slice(0, 25) + '…' : info.name;
    var nameFs = 18;
    var nameW = Math.max(approxTextWidth(dispName, nameFs) + 20, R * 1.8);
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

    // Clic sur la pastille = recentrer l'arbre ici (dérouler cette branche)
    g.addEventListener('click', function () { if (opts.onSelect) opts.onSelect(id); });

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
      eb.addEventListener('click', function (e) { e.stopPropagation(); if (opts.onSelect) opts.onSelect(id); });
      g.appendChild(eb);
    }
    group.appendChild(g);
  }

  // --- Ascendants (numérotation d'Ahnentafel : 1=racine, 2n=père, 2n+1=mère) ---

  function buildAncestors(state, rootId, maxGen) {
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
            class: 'tree-edge tree-edge-union',
            d: 'M ' + dotX + ' ' + dotY + ' V ' + a.cy + ' H ' + (a.cx - R)
          }));
          edgesGroup.appendChild(svgEl('path', {
            class: 'tree-edge tree-edge-union',
            d: 'M ' + dotX + ' ' + dotY + ' V ' + b.cy + ' H ' + (b.cx - R)
          }));
          edgesGroup.appendChild(svgEl('path', {
            class: 'tree-edge tree-edge-child',
            d: 'M ' + (child.cx + R) + ' ' + child.cy + ' H ' + dotX + ' V ' + dotY
          }));
        } else {
          var single = a || b;
          if (!single) continue;
          var midX = (child.cx + R + single.cx - R) / 2;
          edgesGroup.appendChild(svgEl('path', {
            class: 'tree-edge tree-edge-child',
            d: 'M ' + (child.cx + R) + ' ' + child.cy + ' H ' + midX + ' V ' + single.cy + ' H ' + (single.cx - R)
          }));
        }
      }
    }
  }

  // --- Descendants (tidy tree : largeur de sous-arbre en "unités") ---

  function buildDescendants(state, rootId, maxGen) {
    var positions = {};
    var edges = [];
    var visited = {};

    function width(id, gen) {
      if (visited[id] || gen >= maxGen) return 1;
      visited[id] = true;   // déduplique comme assign() : un même individu n'est compté qu'une fois
      var children = Store.getChildren(state, id);
      if (!children.length) return 1;
      var w = 0;
      children.forEach(function (c) { w += width(c.id, gen + 1); });
      return Math.max(w, 1);
    }

    function assign(id, xStart, gen) {
      visited[id] = true;
      var children = gen < maxGen ? Store.getChildren(state, id) : [];
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
      return { id: id, gen: pos.gen, cx: pos.x * UNIT_W, cy: pos.gen * GEN_H + R };
    });
    var maxGenSeen = nodes.reduce(function (m, n) { return Math.max(m, n.gen); }, 0);
    return {
      nodes: nodes, edges: edges,
      width: totalUnits * UNIT_W + SPOUSE_DX,
      height: (maxGenSeen + 1) * GEN_H
    };
  }

  function renderDescendants(nodesGroup, edgesGroup, state, data, rootId, opts, maxGen) {
    var byId = {};
    data.nodes.forEach(function (n) { byId[n.id] = n; });

    // Point d'union par personne : soit entre elle et son 1er conjoint,
    // soit juste sous elle si aucun conjoint n'est enregistré.
    var unionPoint = {};
    data.nodes.forEach(function (n) {
      var spouses = Store.getSpouses(state, n.id);
      if (spouses.length) {
        unionPoint[n.id] = { x: n.cx + SPOUSE_DX / 2, y: n.cy, spouse: spouses[0] };
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
      var midY = (sy + ey) / 2;
      var d = 'M ' + sx + ' ' + sy + ' V ' + midY + ' H ' + ex + ' V ' + ey;
      edgesGroup.appendChild(svgEl('path', { d: d, class: 'tree-edge tree-edge-child' }));
    });

    data.nodes.forEach(function (n) {
      var p = state.persons[n.id];
      if (!p) return;
      var up = unionPoint[n.id];
      // TOUS les conjoints (remariages inclus) — avant, seul le 1er était affiché,
      // les autres et leurs enfants apparaissaient sans parent.
      var spouses = Store.getSpouses(state, n.id);
      if (spouses.length) {
        var prevX = n.cx;
        spouses.forEach(function (sp, i) {
          var sx = n.cx + SPOUSE_DX + i * (R * 2 + 18);
          edgesGroup.appendChild(svgEl('path', {
            class: 'tree-edge tree-edge-union',
            d: 'M ' + (prevX + R) + ' ' + n.cy + ' H ' + (sx - R)
          }));
          drawDot(edgesGroup, (prevX + sx) / 2, n.cy);
          drawPerson(nodesGroup, sp.id, sp, sx, n.cy, opts, false, true, false);
          prevX = sx;
        });
      } else if (Store.getChildren(state, n.id).length) {
        drawDot(edgesGroup, up.x, up.y);
      }
      var hasHidden = n.gen === maxGen && Store.getChildren(state, n.id).length > 0;
      drawPerson(nodesGroup, n.id, p, n.cx, n.cy, opts, n.id === rootId, false, hasHidden);
    });
  }

  function attachPanZoom(svg, viewport, box) {
    var state = { scale: 1, tx: 0, ty: 0, dragging: false, lastX: 0, lastY: 0 };

    function apply() {
      viewport.setAttribute('transform', 'translate(' + state.tx + ',' + state.ty + ') scale(' + state.scale + ')');
    }

    function fit() {
      var rect = svg.getBoundingClientRect();
      var w = Math.max(rect.width, 200), h = Math.max(rect.height, 200);
      var pad = 60;
      var sx = (w - pad) / box.width;
      var sy = (h - pad) / box.height;
      state.scale = Math.min(sx, sy, 1);
      state.scale = Math.max(state.scale, 0.15);
      state.tx = (w - box.width * state.scale) / 2;
      state.ty = pad / 2;
      apply();
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
      apply();
    }

    svg.addEventListener('pointerdown', function (e) {
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      svg.setPointerCapture(e.pointerId);
      var pts = pointerList();
      if (pts.length === 1) {
        state.dragging = true;
        state.lastX = e.clientX; state.lastY = e.clientY;
      } else if (pts.length === 2) {
        state.dragging = false;
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
      } else if (state.dragging && pts.length === 1) {
        state.tx += e.clientX - state.lastX;
        state.ty += e.clientY - state.lastY;
        state.lastX = e.clientX; state.lastY = e.clientY;
        apply();
      }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      svg.addEventListener(ev, function (e) {
        delete pointers[e.pointerId];
        var pts = pointerList();
        if (pts.length < 2) pinch = null;
        if (pts.length === 0) state.dragging = false;
        else if (pts.length === 1) {
          state.dragging = true;
          state.lastX = pts[0].x; state.lastY = pts[0].y;
        }
      });
    });
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var factor = e.deltaY < 0 ? 1.1 : 0.9;
      var rect = svg.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var newScale = Math.min(Math.max(state.scale * factor, 0.1), 3);
      state.tx = mx - (mx - state.tx) * (newScale / state.scale);
      state.ty = my - (my - state.ty) * (newScale / state.scale);
      state.scale = newScale;
      apply();
    }, { passive: false });

    fit();
    return {
      zoomIn: function () { state.scale = Math.min(state.scale * 1.2, 3); apply(); },
      zoomOut: function () { state.scale = Math.max(state.scale * 0.8, 0.1); apply(); },
      reset: fit
    };
  }

  function render(svg, state, opts) {
    var mode = opts.mode === 'descendants' ? 'descendants' : 'ancestors';
    var maxGen = opts.maxGen || 4;
    var rootId = opts.rootId;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!rootId || !state.persons[rootId]) return null;

    var viewport = svgEl('g', { class: 'tree-viewport' });
    svg.appendChild(viewport);

    var edgesGroup = svgEl('g', { class: 'tree-edges' });
    var nodesGroup = svgEl('g', { class: 'tree-nodes' });
    viewport.appendChild(edgesGroup);
    viewport.appendChild(nodesGroup);

    var data, box;
    if (mode === 'descendants') {
      data = buildDescendants(state, rootId, maxGen);
      renderDescendants(nodesGroup, edgesGroup, state, data, rootId, opts, maxGen);
    } else {
      data = buildAncestors(state, rootId, maxGen);
      renderAncestors(nodesGroup, edgesGroup, state, data, rootId, opts, maxGen);
    }
    box = { width: Math.max(data.width, R * 2), height: Math.max(data.height, R * 2) };

    return attachPanZoom(svg, viewport, box);
  }

  global.Tree = { render: render };
})(window);
