/* Tree — rendu SVG de l'arbre (ascendants et descendants), avec
   pan (glisser) et zoom (molette / boutons). Aucune dépendance externe. */
(function (global) {
  'use strict';

  var BOX_W = 168, BOX_H = 58;
  var COL_GAP = 90, ROW_GAP = 26;

  function svgEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function label(p) {
    var name = Store.fullName(p);
    var b = p.naissance && p.naissance.date ? p.naissance.date.slice(0, 4) : '';
    var d = p.decede || (p.deces && p.deces.date) ? (p.deces && p.deces.date ? p.deces.date.slice(0, 4) : '✝') : '';
    var years = (b || d) ? (b + (d ? ' – ' + d : (p.decede ? ' – ✝' : ''))) : '';
    return { name: name, years: years };
  }

  // --- Ascendants (numérotation d'Ahnentafel : 1=racine, 2n=père, 2n+1=mère) ---

  function buildAncestors(state, rootId, maxGen) {
    var nodes = [];
    var edges = [];
    function rec(id, gen, slot) {
      if (!id || gen > maxGen) return;
      nodes.push({ id: id, gen: gen, slot: slot });
      if (gen === maxGen) return;
      var p = state.persons[id];
      if (!p) return;
      var parents = p.parentIds || [];
      if (parents[0]) { edges.push({ from: id, to: parents[0] }); rec(parents[0], gen + 1, slot * 2); }
      if (parents[1]) { edges.push({ from: id, to: parents[1] }); rec(parents[1], gen + 1, slot * 2 + 1); }
    }
    rec(rootId, 0, 0);
    var maxGenSeen = nodes.reduce(function (m, n) { return Math.max(m, n.gen); }, 0);
    var totalH = Math.pow(2, maxGenSeen) * (BOX_H + ROW_GAP);
    nodes.forEach(function (n) {
      var slots = Math.pow(2, n.gen);
      n.x = n.gen * (BOX_W + COL_GAP);
      n.y = (n.slot + 0.5) / slots * totalH - BOX_H / 2;
    });
    return { nodes: nodes, edges: edges, width: (maxGenSeen + 1) * (BOX_W + COL_GAP), height: totalH };
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
      return { id: id, gen: pos.gen, x: pos.x * (BOX_W + COL_GAP), y: pos.gen * (BOX_H + ROW_GAP) };
    });
    var maxGenSeen = nodes.reduce(function (m, n) { return Math.max(m, n.gen); }, 0);
    return {
      nodes: nodes, edges: edges,
      width: totalUnits * (BOX_W + COL_GAP),
      height: (maxGenSeen + 1) * (BOX_H + ROW_GAP)
    };
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

    var data = mode === 'descendants'
      ? buildDescendants(state, rootId, maxGen)
      : buildAncestors(state, rootId, maxGen);

    var viewport = svgEl('g', { class: 'tree-viewport' });
    svg.appendChild(viewport);

    var edgesGroup = svgEl('g', { class: 'tree-edges' });
    var nodesGroup = svgEl('g', { class: 'tree-nodes' });
    viewport.appendChild(edgesGroup);
    viewport.appendChild(nodesGroup);

    var byId = {};
    data.nodes.forEach(function (n) { byId[n.id] = n; });

    data.edges.forEach(function (e) {
      var a = byId[e.from], b = byId[e.to];
      if (!a || !b) return;
      var path;
      if (mode === 'ancestors') {
        var startX = a.x + BOX_W, startY = a.y + BOX_H / 2;
        var endX = b.x, endY = b.y + BOX_H / 2;
        var midX = (startX + endX) / 2;
        path = 'M ' + startX + ' ' + startY + ' H ' + midX + ' V ' + endY + ' H ' + endX;
      } else {
        var sx = a.x + BOX_W / 2, sy = a.y + BOX_H;
        var ex = b.x + BOX_W / 2, ey = b.y;
        var midY = (sy + ey) / 2;
        path = 'M ' + sx + ' ' + sy + ' V ' + midY + ' H ' + ex + ' V ' + ey;
      }
      edgesGroup.appendChild(svgEl('path', { d: path, class: 'tree-edge' }));
    });

    data.nodes.forEach(function (n) {
      var p = state.persons[n.id];
      if (!p) return;
      var g = svgEl('g', { class: 'tree-node sexe-' + (p.sexe || '?'), transform: 'translate(' + n.x + ',' + n.y + ')' });
      if (n.id === rootId) g.classList.add('is-root');
      g.appendChild(svgEl('rect', { class: 'tree-box', width: BOX_W, height: BOX_H, rx: 10 }));
      var info = label(p);
      var t1 = svgEl('text', { class: 'tree-name', x: BOX_W / 2, y: 24 });
      t1.textContent = info.name;
      var t2 = svgEl('text', { class: 'tree-years', x: BOX_W / 2, y: 42 });
      t2.textContent = info.years;
      g.appendChild(t1);
      g.appendChild(t2);
      if (mode === 'descendants') {
        var spouses = Store.getSpouses(state, n.id).map(function (s) { return Store.fullName(s); });
        if (spouses.length) {
          var t3 = svgEl('text', { class: 'tree-spouse', x: BOX_W / 2, y: 52 });
          t3.textContent = '⚭ ' + spouses.join(', ');
          g.appendChild(t3);
        }
      }
      g.addEventListener('click', function () { if (opts.onSelect) opts.onSelect(n.id); });
      nodesGroup.appendChild(g);
    });

    return attachPanZoom(svg, viewport, { width: Math.max(data.width, BOX_W), height: Math.max(data.height, BOX_H) });
  }

  global.Tree = { render: render };
})(window);
