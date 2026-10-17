// Markdown ligero, sin dependencias. Se usa tanto en el renderer (navegador)
// como en Node (pruebas). Incluye: encabezados, listas, tablas, citas,
// enlaces, código con resaltado de sintaxis y código en línea.
(function (root) {
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- Resaltado de sintaxis ----------
  const JS_KW = new Set(('await break case catch class const continue debugger default delete do else enum export extends ' +
    'finally for from function if implements import in instanceof interface let new package private protected public ' +
    'return static super switch this throw try typeof var void while with yield true false null undefined').split(' '));
  const C_KW = new Set(('auto break case char const continue default do double else enum extern float for goto if inline ' +
    'int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile ' +
    'while class namespace new delete this true false nullptr using template typename public private protected virtual ' +
    'override final abstract assert boolean byte extends implements import instanceof package throws transient var ' +
    'record sealed').split(' '));
  const GO_KW = new Set(('break default func interface select case defer go map struct chan else goto package switch ' +
    'fallthrough if range type continue for return var const import var true false nil iota').split(' '));
  const RUST_KW = new Set(('as async await break const continue crate dyn else enum extern false fn for if impl in let ' +
    'loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while ' +
    'union box').split(' '));
  const PY_KW = new Set(('and as assert async await break class continue def del elif else except finally for from ' +
    'global if import in is lambda nonlocal not or pass raise return try while with yield True False None self ' +
    'print len range str int float list dict set').split(' '));
  const SH_KW = new Set(('if then else elif fi for while do done case esac function return in export local readonly ' +
    'source shift trap until break continue cd echo exit set unset').split(' '));
  const SQL_KW = new Set(('select from where insert into values update set delete create table drop alter index join ' +
    'left right inner outer on group by order having limit offset as distinct and or not null primary key foreign ' +
    'references unique default union all like between exists case when then end desc asc').split(' '));
  const JAVA_KW = new Set(('abstract assert boolean break byte case catch char class const continue default do double ' +
    'else enum extends final finally float for if implements import instanceof int interface long native new package ' +
    'private protected public return short static strictfp super switch synchronized this throw throws transient ' +
    'try void volatile while var record yield sealed true false null').split(' '));
  const JSON_KW = new Set(['true', 'false', 'null']);

  const JS_BUILTIN = new Set(('console window document Math JSON Object Array String Number Boolean Promise Map Set ' +
    'Symbol Date RegExp Error fetch setTimeout setInterval require module exports process arguments').split(' '));

  // familia => { line, block, kw, builtin, triple }
  const FAMILIES = {
    js: { line: '//', block: '/\\*[\\s\\S]*?\\*/', kw: JS_KW, builtin: JS_BUILTIN },
    c: { line: '//', block: '/\\*[\\s\\S]*?\\*/', kw: C_KW },
    go: { line: '//', block: '/\\*[\\s\\S]*?\\*/', kw: GO_KW },
    rust: { line: '//', block: '/\\*[\\s\\S]*?\\*/', kw: RUST_KW },
    java: { line: '//', block: '/\\*[\\s\\S]*?\\*/', kw: JAVA_KW },
    python: { line: '#', block: null, kw: PY_KW, triple: true },
    shell: { line: '#', block: null, kw: SH_KW },
    sql: { line: '--', block: '/\\*[\\s\\S]*?\\*/', kw: SQL_KW },
    json: { line: null, block: null, kw: JSON_KW },
    css: { line: null, block: '/\\*[\\s\\S]*?\\*/', kw: new Set(['important']) },
    html: { line: null, block: '<!--[\\s\\S]*?-->', kw: new Set([]) },
    config: { line: '#', block: null, kw: new Set(['true', 'false', 'on', 'off', 'yes', 'no', 'null']) },
  };

  const LANG_TO_FAMILY = {
    js: 'js', javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', cjs: 'js',
    json: 'json', jsonc: 'json',
    c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cs: 'c', csharp: 'c', php: 'c', dart: 'c',
    go: 'go', golang: 'go',
    rust: 'rust', rs: 'rust',
    java: 'java', kt: 'java', kotlin: 'java', swift: 'java', scala: 'java',
    py: 'python', python: 'python', python3: 'python',
    bash: 'shell', sh: 'shell', shell: 'shell', zsh: 'shell', powershell: 'shell', ps1: 'shell', console: 'shell',
    sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', markdown: 'html',
    yaml: 'config', yml: 'config', toml: 'config', ini: 'config', env: 'config', dockerfile: 'config', makefile: 'config',
  };

  function familyFor(lang) {
    if (!lang) return null;
    const key = String(lang).toLowerCase().trim().split(/[\s,:;()+/\\]/)[0];
    return LANG_TO_FAMILY[key] || null;
  }

  function span(cls, text) {
    return '<span class="' + cls + '">' + escapeHtml(text) + '</span>';
  }

  function highlightCode(code, lang) {
    const family = familyFor(lang);
    if (!family) return escapeHtml(code);
    const rules = FAMILIES[family];

    const parts = [];
    if (rules.block) parts.push('(?<block>' + rules.block + ')');
    if (rules.line) parts.push('(?<line>' + rules.line + '[^\\n]*)');
    if (rules.triple) parts.push('(?<tri>"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\')');
    parts.push('(?<str>"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`)');
    parts.push('(?<num>\\b0[xXbBoO][0-9a-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)');
    parts.push('(?<id>[$A-Za-z_][$\\w]*)');

    let re;
    try { re = new RegExp(parts.join('|'), 'g'); } catch { return escapeHtml(code); }

    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      if (m.index > last) out += escapeHtml(code.slice(last, m.index));
      const t = m[0];
      if (m.groups.block) out += span('c-com', t);
      else if (m.groups.line) out += span('c-com', t);
      else if (m.groups.tri) out += span('c-str', t);
      else if (m.groups.str) out += span('c-str', t);
      else if (m.groups.num) out += span('c-num', t);
      else if (m.groups.id) {
        const lower = t.toLowerCase();
        if (rules.kw.has(t) || rules.kw.has(lower)) out += span('c-kw', t);
        else if (rules.builtin && rules.builtin.has(t)) out += span('c-bi', t);
        else if (code[re.lastIndex] === '(') out += span('c-fn', t);
        else out += escapeHtml(t);
      } else out += escapeHtml(t);
      last = re.lastIndex;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (last < code.length) out += escapeHtml(code.slice(last));
    return out;
  }

  // ---------- Formato en línea ----------
  function renderInline(text) {
    let safe = escapeHtml(text);
    const codes = [];
    safe = safe.replace(/`([^`]+)`/g, (_m, code) => {
      codes.push(code);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });

    // Enlaces [texto](url) — solo protocolos seguros.
    safe = safe.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
      const u = url.replace(/&amp;/g, '&');
      if (!/^(https?:|mailto:|#|\/)/i.test(u)) return label;
      return '<a href="' + escapeHtml(u) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });

    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    safe = safe.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    safe = safe.replace(/\n/g, '<br>');
    safe = safe.replace(/\u0000(\d+)\u0000/g, (_m, i) => '<code>' + codes[Number(i)] + '</code>');
    return safe;
  }

  // ---------- Bloques ----------
  function isBlockStart(line) {
    return /^\s*```/.test(line) ||
      /^#{1,6}\s+/.test(line) ||
      /^\s*>/.test(line) ||
      /^\s*[-*+]\s+/.test(line) ||
      /^\s*\d+[.)]\s+/.test(line) ||
      /^\s*\|.*\|\s*$/.test(line) ||
      /^\s*([-*_])\s*(\1\s*){2,}$/.test(line);
  }

  function renderCodeBlock(lines, lang, startIndex) {
    const buf = [];
    let i = startIndex;
    while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
    if (i < lines.length) i++; // cierra el fence
    while (buf.length && buf[buf.length - 1] === '') buf.pop();
    const cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
    return { html: '<pre><code' + cls + '>' + highlightCode(buf.join('\n'), lang) + '</code></pre>', next: i };
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  }

  function renderMarkdownLite(text) {
    const src = String(text == null ? '' : text);
    const lines = src.split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i++; continue; }

      // Bloque de código cercado
      if (/^\s*```/.test(line)) {
        const lang = line.replace(/^\s*```/, '').trim();
        const r = renderCodeBlock(lines, lang, i + 1);
        out.push(r.html);
        i = r.next;
        continue;
      }

      // Encabezados
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lvl = h[1].length;
        out.push('<h' + lvl + '>' + renderInline(h[2]) + '</h' + lvl + '>');
        i++;
        continue;
      }

      // Separador horizontal
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { out.push('<hr>'); i++; continue; }

      // Cita
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + renderMarkdownLite(buf.join('\n')) + '</blockquote>');
        continue;
      }

      // Tabla
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length &&
          /^\s*\|?\s*:?-{2,}[-\s:|]*$/.test(lines[i + 1])) {
        const headers = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        let html = '<table><thead><tr>' + headers.map((c) => '<th>' + renderInline(c) + '</th>').join('') + '</tr></thead><tbody>';
        for (const r of rows) {
          html += '<tr>' + headers.map((_c, ci) => '<td>' + renderInline(r[ci] != null ? r[ci] : '') + '</td>').join('') + '</tr>';
        }
        html += '</tbody></table>';
        out.push(html);
        continue;
      }

      // Listas
      const ulRe = /^\s*[-*+]\s+/;
      const olRe = /^\s*\d+[.)]\s+/;
      if (ulRe.test(line) || olRe.test(line)) {
        const ordered = olRe.test(line) && !ulRe.test(line);
        const re = ordered ? olRe : ulRe;
        const items = [];
        while (i < lines.length && re.test(lines[i])) {
          items.push(lines[i].replace(re, ''));
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>' + items.map((t) => '<li>' + renderInline(t) + '</li>').join('') + '</' + tag + '>');
        continue;
      }

      // Párrafo
      const buf = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (buf.length) out.push('<p>' + renderInline(buf.join('\n')) + '</p>');
      else { i++; } // línea de bloque que no encajó: avanza
    }

    return out.join('');
  }

  const api = { escapeHtml, renderMarkdownLite, highlightCode };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MarkdownLite = api;
})(typeof self !== 'undefined' ? self : this);
