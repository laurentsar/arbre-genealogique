/* Gedcom — export au format GEDCOM 5.5.1 (standard d'échange généalogique)
   et import basique depuis un fichier .ged. */
(function (global) {
  'use strict';

  function gedDate(d) {
    if (!d) return '';
    // Accepte 'YYYY-MM-DD', 'YYYY-MM' ou 'YYYY' et produit un format GEDCOM approximatif.
    var m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(d.trim());
    if (!m) return d;
    var MONTHS = ['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    var parts = [];
    if (m[3]) parts.push(parseInt(m[3], 10));
    if (m[2]) parts.push(MONTHS[parseInt(m[2], 10)]);
    parts.push(m[1]);
    return parts.join(' ');
  }

  function esc(s) {
    return (s || '').replace(/\r?\n/g, ' ').trim();
  }

  function exportGEDCOM(state) {
    var lines = [];
    lines.push('0 HEAD');
    lines.push('1 SOUR Genealogie');
    lines.push('1 GEDC');
    lines.push('2 VERS 5.5.1');
    lines.push('2 FORM LINEAGE-LINKED');
    lines.push('1 CHAR UTF-8');

    var personIndex = {};
    var i = 1;
    Object.keys(state.persons).forEach(function (id) {
      personIndex[id] = '@I' + (i++) + '@';
    });
    var unionIndex = {};
    var j = 1;
    Object.keys(state.unions).forEach(function (id) {
      var u = state.unions[id];
      if (u.partnerIds.length || u.childIds.length) unionIndex[id] = '@F' + (j++) + '@';
    });

    Object.keys(state.persons).forEach(function (id) {
      var p = state.persons[id];
      var ref = personIndex[id];
      lines.push('0 ' + ref + ' INDI');
      var surname = esc(p.nom);
      var given = esc(p.prenom);
      lines.push('1 NAME ' + given + ' /' + surname + '/');
      if (given) lines.push('2 GIVN ' + given);
      if (surname) lines.push('2 SURN ' + surname);
      lines.push('1 SEX ' + (p.sexe === 'H' ? 'M' : p.sexe === 'F' ? 'F' : 'U'));
      if (p.naissance && (p.naissance.date || p.naissance.lieu)) {
        lines.push('1 BIRT');
        if (p.naissance.date) lines.push('2 DATE ' + gedDate(p.naissance.date));
        if (p.naissance.lieu) lines.push('2 PLAC ' + esc(p.naissance.lieu));
      }
      if (p.decede || (p.deces && (p.deces.date || p.deces.lieu))) {
        lines.push('1 DEAT Y');
        if (p.deces && p.deces.date) lines.push('2 DATE ' + gedDate(p.deces.date));
        if (p.deces && p.deces.lieu) lines.push('2 PLAC ' + esc(p.deces.lieu));
      }
      if (p.notes) lines.push('1 NOTE ' + esc(p.notes));
      (p.unionIds || []).forEach(function (uidKey) {
        if (unionIndex[uidKey]) lines.push('1 FAMS ' + unionIndex[uidKey]);
      });
      Object.keys(unionIndex).forEach(function (uidKey) {
        var u = state.unions[uidKey];
        if (u.childIds.indexOf(id) !== -1) lines.push('1 FAMC ' + unionIndex[uidKey]);
      });
    });

    Object.keys(unionIndex).forEach(function (uidKey) {
      var u = state.unions[uidKey];
      var ref = unionIndex[uidKey];
      lines.push('0 ' + ref + ' FAM');
      u.partnerIds.forEach(function (pid, idx) {
        var p = state.persons[pid];
        // Le sexe connu prime TOUJOURS sur la position : sinon un couple
        // stocké [femme, homme] (l'homme en position 1) faisait retomber sur
        // le repli positionnel et étiquetait l'homme WIFE à tort — l'import
        // (voir plus haut) ne gardant qu'un HUSB et une WIFE, ce second
        // partenaire mal étiqueté finissait par disparaître au ré-import.
        var tag = (p && p.sexe === 'F') ? 'WIFE' : (p && p.sexe === 'H') ? 'HUSB' : (idx === 1 ? 'WIFE' : 'HUSB');
        if (personIndex[pid]) lines.push('1 ' + tag + ' ' + personIndex[pid]);
      });
      u.childIds.forEach(function (cid) {
        if (personIndex[cid]) lines.push('1 CHIL ' + personIndex[cid]);
      });
      if (u.dateDebut || u.lieuDebut) {
        lines.push('1 MARR');
        if (u.dateDebut) lines.push('2 DATE ' + gedDate(u.dateDebut));
        if (u.lieuDebut) lines.push('2 PLAC ' + esc(u.lieuDebut));
      }
    });

    lines.push('0 TRLR');
    return lines.join('\n');
  }

  function parseGEDCOM(text) {
    var raw = text.split(/\r?\n/);
    var records = [];
    // Pile des derniers nœuds vus par niveau (stack[level] = dernier nœud à ce niveau).
    var stack = [];
    raw.forEach(function (line) {
      var m = /^(\d+)\s+(@\S+@\s+)?(\S+)(?:\s(.*))?$/.exec(line.trim());
      if (!m) return;
      var level = parseInt(m[1], 10);
      var xref = m[2] ? m[2].trim() : null;
      var tag = m[3];
      var value = m[4] || '';
      var node = { level: level, tag: tag, value: value, xref: xref, children: [] };
      if (level === 0) {
        records.push(node);
      } else {
        var parent = stack[level - 1];
        if (parent) parent.children.push(node);
      }
      stack[level] = node;
      stack.length = level + 1;
    });

    var state = { persons: {}, unions: {}, rootId: null, meta: { version: 1 } };
    var idMap = {};

    function getChild(node, tag) {
      return (node.children || []).find(function (c) { return c.tag === tag; });
    }
    function getChildren(node, tag) {
      return (node.children || []).filter(function (c) { return c.tag === tag; });
    }
    var GED_MONTHS = {
      JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
      JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12
    };
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    // Convertit une date GEDCOM (« 12 JAN 1900 », « JAN 1900 », « ABT 1900 »,
    // « BET 1900 AND 1905 »…) vers le format interne AAAA / AAAA-MM / AAAA-MM-JJ,
    // en gardant le JOUR et le MOIS (l'ancienne version ne gardait que l'année).
    // Les qualificatifs (ABT/BEF/AFT/EST/CAL/FROM/TO/BET/AND) sont ignorés ; pour
    // une fourchette on retient la première date.
    function gedToISODate(val) {
      if (!val) return '';
      var up = String(val).toUpperCase();
      var year = up.match(/\b(\d{3,4})\b/);
      if (!year) return '';
      var mon = up.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/);
      var day = up.match(/\b(\d{1,2})\b/);
      var out = year[1].length === 3 ? '0' + year[1] : year[1];
      if (mon) {
        out += '-' + pad2(GED_MONTHS[mon[1]]);
        if (day) out += '-' + pad2(parseInt(day[1], 10));
      }
      return out;
    }
    function dateFromNode(node) {
      var d = getChild(node, 'DATE');
      var p = getChild(node, 'PLAC');
      return { date: d ? gedToISODate(d.value) : '', lieu: p ? p.value.trim() : '' };
    }
    // Texte d'une note, en recollant les continuations GEDCOM : CONC = collé,
    // CONT = nouvelle ligne. Sans ça les notes longues étaient tronquées à la
    // première ligne.
    function noteText(node) {
      if (!node) return '';
      var t = node.value || '';
      (node.children || []).forEach(function (c) {
        if (c.tag === 'CONC') t += c.value;
        else if (c.tag === 'CONT') t += '\n' + c.value;
      });
      return t;
    }

    records.filter(function (r) { return r.tag === 'INDI'; }).forEach(function (r) {
      var id = Store.uid();
      idMap[r.xref] = id;
      var nameNode = getChild(r, 'NAME');
      var given = '', surname = '';
      if (nameNode) {
        var m = /^([^/]*)\/([^/]*)\//.exec(nameNode.value);
        if (m) { given = m[1].trim(); surname = m[2].trim(); }
        else { given = nameNode.value.trim(); }
      }
      var sexNode = getChild(r, 'SEX');
      var sexe = sexNode ? (sexNode.value === 'M' ? 'H' : sexNode.value === 'F' ? 'F' : '?') : '?';
      var birt = getChild(r, 'BIRT');
      var deat = getChild(r, 'DEAT');
      var noteNode = getChild(r, 'NOTE');
      state.persons[id] = {
        id: id, prenom: given, nom: surname, sexe: sexe,
        naissance: birt ? dateFromNode(birt) : { date: '', lieu: '' },
        deces: deat ? dateFromNode(deat) : { date: '', lieu: '' },
        decede: !!deat,
        notes: noteText(noteNode),
        parentIds: [], unionIds: []
      };
    });

    records.filter(function (r) { return r.tag === 'FAM'; }).forEach(function (r) {
      var uidKey = Store.uid();
      // TOUS les HUSB/WIFE, pas juste le premier de chaque : certains exports
      // (Heredis notamment) taguent parfois deux WIFE au lieu d'un HUSB+WIFE
      // sur une même famille — avec un seul de chaque, le second parent
      // (homme, mal étiqueté WIFE) disparaissait silencieusement à l'import,
      // coupant la branche du reste de l'arbre sans qu'aucune erreur
      // n'apparaisse. getChildren (pluriel) récupère tous les tags présents,
      // quel que soit leur nombre ou leur étiquette exacte.
      var partnerIds = getChildren(r, 'HUSB').concat(getChildren(r, 'WIFE'))
        .map(function (c) { return idMap[c.value]; }).filter(Boolean);
      var childIds = getChildren(r, 'CHIL').map(function (c) { return idMap[c.value]; }).filter(Boolean);
      var marr = getChild(r, 'MARR');
      var md = marr ? dateFromNode(marr) : { date: '', lieu: '' };
      state.unions[uidKey] = {
        id: uidKey, partnerIds: partnerIds, childIds: childIds,
        statut: '', dateDebut: md.date, lieuDebut: md.lieu, dateFin: ''
      };
      partnerIds.forEach(function (pid) {
        state.persons[pid].unionIds.push(uidKey);
      });
      childIds.forEach(function (cid) {
        state.persons[cid].parentIds = partnerIds.slice();
      });
    });

    var first = Object.keys(state.persons)[0];
    state.rootId = first || null;
    return state;
  }

  global.Gedcom = { exportGEDCOM: exportGEDCOM, parseGEDCOM: parseGEDCOM };
})(window);
