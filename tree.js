/* Tree — rendu SVG de l'arbre (ascendants et descendants), avec
   pan (glisser) et zoom (molette / boutons). Aucune dépendance externe.
   Style inspiré des arbres généalogiques « à pastilles » : personnes en
   cercles, point d'union entre conjoints, ligne d'union vers les enfants. */
(function (global) {
  'use strict';

  var R = 30;          // rayon des cercles-personnes
  var DOT_R = 6;        // rayon du point d'union
  var COL_W = 220;       // ascendants : largeur d'une colonne (une génération)
  var ROW_UNIT = 110;     // ascendants : hauteur réservée par personne
  var UNIT_W = 220;      // descendants : largeur réservée par personne (branche)
  var GEN_H = 170;       // descendants : hauteur entre deux générations
  var SPOUSE_DX = 106;    // descendants : décalage horizontal conjoint

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

  function drawPerson(group, id, p, cx, cy, opts, isRoot, isSpouse) {
    var cls = 'tree-node sexe-' + (p.sexe || '?');
    if (isRoot) cls += ' is-root';
    if (isSpouse) cls += ' is-spouse';
    var g = svgEl('g', { class: cls, transform: 'translate(' + cx + ',' + cy + ')' });
    g.appendChild(svgEl('circle', { class: 'tree-avatar', r: R }));
    var initEl = svgEl('text', { class: 'tree-initials', 'text-anchor': 'middle', dy: '0.34em' });
    initEl.textContent = initials(p);
    g.appendChild(initEl);
    var info = label(p);
    var nameEl = svgEl('text', { class: 'tree-name', 'text-anchor': 'middle', y: R + 18 });
    nameEl.textContent = info.name;
    var yearsEl = svgEl('text', { class: 'tree-years', 'text-anchor': 'middle', y: R + 33 });
    yearsEl.textContent = info.years;
    g.appendChild(nameEl);
    g.appendChild(yearsEl);
    g.addEventListener('click', function () { if (opts.onSelect) opts.onSelect(id); });
    group.appendChild(g);
  }

  // --- Ascendants (numérotation d'Ahnentafel : 1=racine, 2n=père, 2n+1=mère) ---

  function buildAncestors(state, rootId, maxGen) {
    var nodes = [];
    var byKey = {};
    function rec(id, gen, slot) {
      if (!id || gen > maxGen) return;
      var n = { id: id, gen: gen, slot: slot };
      nodes.push(n);
      byKey[gen + '_' + slot] = n;
      if (gen === maxGen) return;
      var p = state.persons[id];
      if (!p) return;
      var parents = p.parentIds || [];
      if (parents[0]) rec(parents[0], gen + 1, slot * 2);
      if (parents[1]) rec(parents[1], gen + 1, slot * 2 + 1);
    }
    rec(rootId, 0, 0);
    var maxGenSeen = nodes.reduce(function (m, n) { return Math.max(m, n.gen); }, 0);
    var totalH = Math.pow(2, maxGenSeen) * ROW_UNIT;
    nodes.forEach(function (n) {
      var slots = Math.pow(2, n.gen);
      n.cx = n.gen * COL_W + R;
      n.cy = (n.slot + 0.5) / slots * totalH;
    });
    return {
      nodes: nodes, byKey: byKey, maxGen: maxGenSeen,
      width: (maxGenSeen + 1) * COL_W + R, height: totalH
    };
  }

  function renderAncestors(nodesGroup, edgesGroup, state, data, rootId, opts) {
    data.nodes.forEach(function (n) {
      var p = state.persons[n.id];
      if (!p) return;
      drawPerson(nodesGroup, n.id, p, n.cx, n.cy, opts, n.id === rootId, false);
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

  function renderDescendants(nodesGroup, edgesGroup, state, data, rootId, opts) {
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
      if (up.spouse) {
        edgesGroup.appendChild(svgEl('path', {
          class: 'tree-edge tree-edge-union',
          d: 'M ' + (n.cx + R) + ' ' + n.cy + ' H ' + (n.cx + SPOUSE_DX - R)
        }));
        drawDot(edgesGroup, up.x, up.y);
        drawPerson(nodesGroup, up.spouse.id, up.spouse, n.cx + SPOUSE_DX, n.cy, opts, false, true);
      } else if (Store.getChildren(state, n.id).length) {
        drawDot(edgesGroup, up.x, up.y);
      }
      drawPerson(nodesGroup, n.id, p, n.cx, n.cy, opts, n.id === rootId, false);
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

    svg.addEventListener('pointerdown', function (e) {
      state.dragging = true;
      state.lastX = e.clientX; state.lastY = e.clientY;
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', function (e) {
      if (!state.dragging) return;
      state.tx += e.clientX - state.lastX;
      state.ty += e.clientY - state.lastY;
      state.lastX = e.clientX; state.lastY = e.clientY;
      apply();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      svg.addEventListener(ev, function () { state.dragging = false; });
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
      renderDescendants(nodesGroup, edgesGroup, state, data, rootId, opts);
    } else {
      data = buildAncestors(state, rootId, maxGen);
      renderAncestors(nodesGroup, edgesGroup, state, data, rootId, opts);
    }
    box = { width: Math.max(data.width, R * 2), height: Math.max(data.height, R * 2) };

    return attachPanZoom(svg, viewport, box);
  }

  global.Tree = { render: render };
})(window);
