let currentConversationId = null;
let currentMessages = [];
let pendingAttachments = [];
let isStreaming = false;
let cancelCurrentStream = null;
let currentView = 'chats';

const el = (id) => document.getElementById(id);
const messagesEl = el('messages');
const convoListEl = el('convoList');
const userSelect = el('userSelect');
const textInput = el('textInput');

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------- Markdown ----------
// Viene de src/lib/markdownLite.js (mismo código que se prueba con Node).
const { escapeHtml, renderMarkdownLite } = window.MarkdownLite;

// ---------- Modal genérico de contraseña (login, crear, cambiar) ----------
function askPassword({ title, requireCurrent = false, newLabel = 'Contraseña', allowEmpty = false, confirmNew = false }) {
  return new Promise((resolve) => {
    el('pwModalTitle').textContent = title;
    el('pwCurrentRow').classList.toggle('hidden', !requireCurrent);
    el('pwCurrentInput').value = '';
    el('pwNewLabel').textContent = newLabel;
    el('pwNewInput').value = '';
    el('pwConfirmRow').classList.toggle('hidden', !confirmNew);
    el('pwConfirmInput').value = '';
    el('pwError').classList.add('hidden');
    el('passwordModal').classList.remove('hidden');
    el('pwCurrentRow').classList.contains('hidden') ? el('pwNewInput').focus() : el('pwCurrentInput').focus();

    function showError(msg) {
      el('pwError').textContent = msg;
      el('pwError').classList.remove('hidden');
    }
    function cleanup() {
      el('passwordModal').classList.add('hidden');
      el('pwConfirmBtn').removeEventListener('click', onOk);
      el('pwCancelBtn').removeEventListener('click', onCancel);
    }
    function onOk() {
      const current = el('pwCurrentInput').value;
      const next = el('pwNewInput').value;
      if (confirmNew && next !== el('pwConfirmInput').value) return showError('Las contraseñas no coinciden.');
      if (!allowEmpty && !next) return showError('Escribe una contraseña (o cancela).');
      cleanup();
      resolve({ current: current || null, next: next || null });
    }
    function onCancel() { cleanup(); resolve(null); }
    el('pwConfirmBtn').addEventListener('click', onOk);
    el('pwCancelBtn').addEventListener('click', onCancel);
  });
}

// ---------- Usuarios ----------
async function refreshUsers() {
  const users = await window.api.listUsers();
  const current = await window.api.getCurrentUser();
  userSelect.innerHTML = users.map((u) =>
    `<option value="${u.id}" ${u.id === current.id ? 'selected' : ''}>${u.hasPassword ? '🔒 ' : ''}${escapeHtml(u.name)}</option>`
  ).join('');
  const name = (current && current.name) || '';
  el('drawerProfileName').textContent = name || 'Usuario';
  el('profileAvatar').textContent = (name.trim().charAt(0) || '?').toUpperCase();
  el('heroName').textContent = name.trim() || 'there';
}

userSelect.addEventListener('change', async () => {
  if (isStreaming) { await refreshUsers(); return; }
  const targetId = userSelect.value;
  const users = await window.api.listUsers();
  const target = users.find((u) => u.id === targetId);
  let password = null;

  if (target && target.hasPassword) {
    const res = await askPassword({ title: `Contraseña de ${target.name}`, newLabel: 'Contraseña' });
    if (!res) { await refreshUsers(); return; } // canceló: vuelve al usuario actual
    password = res.next;
  }

  const result = await window.api.switchUser(targetId, password);
  if (!result.ok) {
    alert('Contraseña incorrecta.');
    await refreshUsers();
    return;
  }
  await refreshConversations();
  await refreshSkills();
  clearChat();
});

el('newUserBtn').addEventListener('click', async () => {
  const name = prompt('Nombre del nuevo usuario/perfil:');
  if (!name) return;
  const res = await askPassword({
    title: `Contraseña para "${name}" (opcional)`,
    newLabel: 'Contraseña (déjalo vacío para no usar una)',
    allowEmpty: true,
  });
  if (res === null) return;
  await window.api.createUser(name, res.next || undefined);
  await refreshUsers();
  await refreshConversations();
  await refreshSkills();
  clearChat();
});

el('userPwBtn').addEventListener('click', async () => {
  const current = await window.api.getCurrentUser();
  const res = await askPassword({
    title: current.hasPassword ? `Cambiar contraseña de ${current.name}` : `Poner contraseña a ${current.name}`,
    requireCurrent: current.hasPassword,
    newLabel: 'Nueva contraseña (vacío = quitarla)',
    allowEmpty: true,
  });
  if (!res) return;

  const result = await window.api.setUserPassword(current.id, res.current, res.next);
  if (!result.ok) {
    alert('La contraseña actual no es correcta.');
    return;
  }
  await refreshUsers();
  alert(result.user.hasPassword ? 'Contraseña actualizada.' : 'Se quitó la contraseña de este usuario.');
});

// ---------- Conversaciones ----------
let convosCache = [];
let foldersCache = [];
const collapsedFolders = new Set();

function relTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (diff < 7 * 86400) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function setProjectName(title) {
  const t = (title || '').trim() || 'Nueva conversación';
  el('titlebarProject').textContent = t;
  el('crumbProject').textContent = t;
}

function buildConvoItem(c) {
  const isActive = c.id === currentConversationId;
  const item = document.createElement('div');
  item.className = 'convo-item' + (isActive ? ' active' : '');
  item.innerHTML = `<span class="convo-dot" aria-hidden="true"></span>` +
    `<span class="title">${escapeHtml(c.title || 'Sin título')}</span>` +
    (isActive ? '<span class="active-tag">Active</span>' : `<span class="convo-time">${relTime(c.updatedAt)}</span>`) +
    `<span class="actions">` +
    `<span class="mov" title="Mover a carpeta"><svg class="ico ico-sm"><use href="#i-folder-open"></use></svg></span>` +
    `<span class="ren" title="Renombrar"><svg class="ico ico-sm"><use href="#i-pencil"></use></svg></span>` +
    `<span class="del" title="Borrar"><svg class="ico ico-sm"><use href="#i-trash"></use></svg></span></span>`;
  item.addEventListener('click', (e) => {
    if (e.target.closest('.del, .ren, .mov')) return;
    loadConversation(c.id);
  });
  item.querySelector('.mov').addEventListener('click', (e) => {
    e.stopPropagation();
    showMoveMenu(c, e.target);
  });
  item.querySelector('.ren').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isStreaming) return;
    const nuevo = prompt('Nuevo título de la conversación:', c.title || '');
    if (nuevo === null) return;
    const titulo = nuevo.trim();
    if (!titulo) return;
    await window.api.renameConversation(c.id, titulo);
    refreshConversations();
  });
  item.querySelector('.del').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isStreaming) return;
    await window.api.deleteConversation(c.id);
    if (currentConversationId === c.id) { currentConversationId = null; clearChat(); }
    refreshConversations();
  });
  return item;
}

// Menú flotante para mover una conversación de carpeta.
function showMoveMenu(c, anchor) {
  document.querySelectorAll('.move-menu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'move-menu';
  const addItem = (label, fn) => {
    const it = document.createElement('div');
    it.className = 'move-menu-item' + (fn === null ? ' muted' : '');
    it.innerHTML = label;
    it.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      if (fn) fn();
    });
    menu.appendChild(it);
  };
  if (c.folderId) addItem('<svg class="ico ico-sm"><use href="#i-folder-open"></use></svg> Sin carpeta', async () => {
    await window.api.setConversationFolder(c.id, null);
    refreshConversations();
  });
  for (const f of foldersCache) {
    if (f.id === c.folderId) continue;
    addItem(`<svg class="ico ico-sm"><use href="#i-folder"></use></svg> ${escapeHtml(f.name)}`, async () => {
      await window.api.setConversationFolder(c.id, f.id);
      refreshConversations();
    });
  }
  if (foldersCache.length || c.folderId) {
    const sep = document.createElement('div');
    sep.className = 'move-menu-sep';
    menu.appendChild(sep);
  }
  addItem('<svg class="ico ico-sm"><use href="#i-plus"></use></svg> Nueva carpeta…', async () => {
    const nombre = prompt('Nombre de la carpeta:');
    if (!nombre || !nombre.trim()) return;
    const f = await window.api.createFolder(nombre.trim());
    await window.api.setConversationFolder(c.id, f.id);
    refreshConversations();
  });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8) + 'px';
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
  setTimeout(() => {
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 0);
}

async function refreshConversations() {
  [convosCache, foldersCache] = await Promise.all([
    window.api.listConversations(),
    window.api.listFolders(),
  ]);
  const q = (el('convoSearch').value || '').toLowerCase().trim();
  convoListEl.innerHTML = '';

  // Búsqueda activa: lista plana de coincidencias (ignora carpetas).
  if (q) {
    const matches = convosCache.filter((c) => (c.title || '').toLowerCase().includes(q));
    if (!matches.length) convoListEl.innerHTML = '<p class="hint" style="padding:6px 8px">Sin resultados.</p>';
    for (const c of matches) convoListEl.appendChild(buildConvoItem(c));
    return;
  }

  const byFolder = new Map();
  for (const c of convosCache) {
    const key = c.folderId || null;
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(c);
  }

  for (const f of foldersCache) {
    const convos = byFolder.get(f.id) || [];
    const head = document.createElement('div');
    head.className = 'folder-head';
    const collapsed = collapsedFolders.has(f.id);
    head.innerHTML = `<span class="fold-ico"><svg class="ico"><use href="${collapsed ? '#i-chev-right' : '#i-chev-down'}"></use></svg></span>` +
      `<span class="folder-name"><svg class="ico ico-sm"><use href="#i-folder"></use></svg> ${escapeHtml(f.name)}</span>` +
      `<span class="hint count">${convos.length}</span>` +
      `<span class="actions"><span class="ren" title="Renombrar carpeta"><svg class="ico ico-sm"><use href="#i-pencil"></use></svg></span><span class="del" title="Eliminar carpeta"><svg class="ico ico-sm"><use href="#i-trash"></use></svg></span></span>`;
    head.querySelector('.ren').addEventListener('click', async (e) => {
      e.stopPropagation();
      const nuevo = prompt('Nuevo nombre de la carpeta:', f.name);
      if (nuevo === null || !nuevo.trim()) return;
      await window.api.renameFolder(f.id, nuevo.trim());
      refreshConversations();
    });
    head.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      const n = convos.length;
      const msg = n ? `¿Eliminar la carpeta "${f.name}"? Sus ${n} conversación(es) quedarán sin carpeta.` : `¿Eliminar la carpeta "${f.name}"?`;
      if (!confirm(msg)) return;
      await window.api.deleteFolder(f.id);
      refreshConversations();
    });
    head.addEventListener('click', () => {
      if (collapsedFolders.has(f.id)) collapsedFolders.delete(f.id);
      else collapsedFolders.add(f.id);
      refreshConversations();
    });
    convoListEl.appendChild(head);
    if (!collapsed) for (const c of convos) convoListEl.appendChild(buildConvoItem(c));
  }

  const loose = byFolder.get(null) || [];
  if (loose.length || !foldersCache.length) {
    const head = document.createElement('div');
    head.className = 'folder-head plain';
    head.innerHTML = `<span class="folder-name">${foldersCache.length ? '<svg class="ico ico-sm"><use href="#i-folder-open"></use></svg>' : '<svg class="ico ico-sm"><use href="#i-chat"></use></svg>'} ${foldersCache.length ? 'Sin carpeta' : 'Conversaciones'}</span>` +
      `<span class="hint count">${loose.length}</span>`;
    convoListEl.appendChild(head);
    for (const c of loose) convoListEl.appendChild(buildConvoItem(c));
  }
}

el('newFolderBtn').addEventListener('click', async () => {
  const nombre = prompt('Nombre de la carpeta:');
  if (!nombre || !nombre.trim()) return;
  await window.api.createFolder(nombre.trim());
  refreshConversations();
});

function setWelcomeVisible(show) {
  el('welcome').classList.toggle('hidden', !show);
}

function clearChat() {
  currentMessages = [];
  messagesEl.innerHTML = '';
  setProjectName(null);
  setWelcomeVisible(true);
  updateContextMeter();
}

async function loadConversation(id) {
  if (isStreaming) return;
  if (currentView !== 'chats') setMainView('chats');
  const convo = await window.api.loadConversation(id);
  if (!convo) { clearChat(); return; }
  currentConversationId = id;
  renderMessages(convo.messages || []);
  setProjectName(convo.title || null);
  // Restaura el skill activo de esta conversación en el selector.
  el('skillSelect').value = convo.skillId && cachedSkills.some((s) => s.id === convo.skillId) ? convo.skillId : '';
  refreshConversations();
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

function imageBlockHtml(block) {
  const data = (block.source && block.source.data) || block.base64;
  const mime = (block.source && block.source.media_type) || block.mediaType || 'image/png';
  if (data) {
    return `<img class="msg-img" src="data:${mime};base64,${data}" alt="${escapeHtml(block.fileName || 'imagen')}" title="${escapeHtml(block.fileName || 'imagen')}" />`;
  }
  return `<div class="att-tag"><svg class="ico ico-sm"><use href="#i-image"></use></svg> ${escapeHtml(block.fileName || 'imagen')}</div>`;
}

function enhanceCodeBlocks(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.dataset.enh) return;
    pre.dataset.enh = '1';
    const code = pre.querySelector('code');
    const langMatch = code && (code.className.match(/language-(\S+)/) || []);
    const lang = langMatch && langMatch[1] ? langMatch[1] : 'code';
    const bar = document.createElement('div');
    bar.className = 'code-bar';
    const label = document.createElement('span');
    label.className = 'code-lang';
    label.textContent = lang;
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.type = 'button';
    btn.textContent = 'Copiar';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code ? code.innerText : pre.innerText);
        btn.textContent = '✓ Copiado';
      } catch { btn.textContent = '✗ Error'; }
      setTimeout(() => { btn.textContent = 'Copiar'; }, 1500);
    });
    bar.appendChild(label);
    bar.appendChild(btn);
    pre.insertBefore(bar, pre.firstChild);
  });
}

function renderMessages(messages) {
  currentMessages = messages || [];
  messagesEl.innerHTML = '';
  currentMessages.forEach((m, idx) => {
    if (m.role === 'assistant' && m.thinking) appendBubble('thinking', m.thinking, -1, null);
    if (m.role === 'user' || m.role === 'assistant') appendBubble(m.role, m.content, idx, m);
  });
  setWelcomeVisible(currentMessages.length === 0);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateContextMeter();
}

function appendBubble(role, content, index, msg) {
  setWelcomeVisible(false);
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  let html = '';
  if (typeof content === 'string') {
    html = renderMarkdownLite(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') html += renderMarkdownLite(block.text || '');
      else if (block.type === 'image') html += imageBlockHtml(block);
      else if (block.type === 'document') html += `<div class="att-tag"><svg class="ico ico-sm"><use href="#i-file"></use></svg> ${escapeHtml(block.fileName || 'documento')}</div>`;
      else if (block.kind === 'image') html += `<div class="att-tag"><svg class="ico ico-sm"><use href="#i-image"></use></svg> ${escapeHtml(block.fileName || 'imagen')}</div>`;
      else if (block.kind) html += `<div class="att-tag"><svg class="ico ico-sm"><use href="#i-file"></use></svg> ${escapeHtml(block.fileName || 'archivo')}</div>`;
    }
  }
  div.innerHTML = html;
  enhanceCodeBlocks(div);

  // Uso de tokens bajo las respuestas del asistente.
  if (msg && msg.usage && (msg.usage.input || msg.usage.output)) {
    const ut = document.createElement('div');
    ut.className = 'usage-tag';
    const total = msg.usage.total || (msg.usage.input || 0) + (msg.usage.output || 0);
    ut.textContent = `↑ ${msg.usage.input || 0} · ↓ ${msg.usage.output || 0} tokens (total ${total})`;
    ut.title = 'Tokens de entrada (prompt) y salida (respuesta)';
    div.appendChild(ut);
  }

  // Barra de acciones (aparece al pasar el cursor).
  if (typeof index === 'number' && index >= 0 && (role === 'user' || role === 'assistant')) {
    div.appendChild(buildActionsBar(role, index, msg));
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function buildActionsBar(role, index, msg) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  const mk = (icon, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.innerHTML = `<svg class="ico ico-sm"><use href="#${icon}"></use></svg>`;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    bar.appendChild(b);
  };
  mk('i-copy', 'Copiar texto', async () => {
    try {
      await navigator.clipboard.writeText(contentToText(msg ? msg.content : ''));
    } catch { /* sin permiso de portapapeles */ }
  });
  if (role === 'user') {
    mk('i-pencil', 'Editar y reenviar', () => editAndResend(index));
  } else {
    mk('i-refresh', 'Regenerar respuesta', () => regenerateReply());
  }
  mk('i-trash', 'Eliminar mensaje', () => deleteMessageAt(index));
  return bar;
}

async function deleteMessageAt(index) {
  if (isStreaming || !currentConversationId) return;
  if (!confirm('¿Eliminar este mensaje de la conversación?')) return;
  const res = await window.api.deleteMessage(currentConversationId, index);
  if (res && res.ok) renderMessages(res.conversation.messages);
}

async function editAndResend(index) {
  if (isStreaming) return;
  const m = currentMessages[index];
  if (!m) return;
  const actual = contentToText(m.content);
  const nuevo = prompt('Edita tu mensaje y se reenviará:', actual);
  if (nuevo === null) return;
  const text = nuevo.trim();
  if (!text || text === actual.trim()) return;
  await runChat({ mode: 'edit', truncateTo: index, newText: text });
}

async function regenerateReply() {
  if (isStreaming) return;
  if (!currentMessages.some((m) => m.role === 'user')) return;
  await runChat({ mode: 'regenerate' });
}

el('newChatBtn').addEventListener('click', async () => {
  if (isStreaming) return;
  if (currentView !== 'chats') setMainView('chats');
  const convo = await window.api.createConversation();
  currentConversationId = convo.id;
  clearChat();
  refreshConversations();
});

// ---------- Adjuntos ----------
el('attachBtn').addEventListener('click', async () => {
  const file = await window.api.pickFile();
  if (!file) return;
  pendingAttachments.push(file);
  renderAttachmentPreview();
});
function renderAttachmentPreview() {
  const box = el('attachmentPreview');
  box.innerHTML = pendingAttachments.map((f, i) => `
    <div class="attachment-chip">
      ${f.kind === 'image' ? '<svg class="ico ico-sm"><use href="#i-image"></use></svg>' : '<svg class="ico ico-sm"><use href="#i-file"></use></svg>'} ${escapeHtml(f.fileName)}
      <span class="remove" data-i="${i}" title="Quitar"><svg class="ico ico-sm"><use href="#i-x"></use></svg></span>
    </div>`).join('');
  box.querySelectorAll('.remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingAttachments.splice(Number(btn.dataset.i), 1);
      renderAttachmentPreview();
    });
  });
}

// ---------- Envío de mensajes ----------
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    runChat();
  }
});
textInput.addEventListener('input', () => {
  textInput.style.height = 'auto';
  textInput.style.height = Math.min(textInput.scrollHeight, 160) + 'px';
});

// ---------- Generar imágenes con IA (Pollinations, gratis) ----------
el('genImgBtn').addEventListener('click', async () => {
  if (isStreaming) return;
  const p = prompt('Describe la imagen que quieres generar:');
  if (p === null) return;
  const text = p.trim();
  if (!text) return;
  const btn = el('genImgBtn');
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<svg class="ico ico-sm spin"><use href="#i-refresh"></use></svg>';
  btn.title = 'Generando imagen… (puede tardar hasta 1 minuto)';
  const res = await window.api.generateImage(text);
  btn.disabled = false;
  btn.innerHTML = old;
  btn.title = 'Generar una imagen con IA (Pollinations, gratis)';
  if (!res.ok) {
    alert('No se pudo generar la imagen.\n' + (res.message || res.error || ('HTTP ' + res.status)));
    return;
  }
  if (!currentConversationId) {
    const convo = await window.api.createConversation();
    currentConversationId = convo.id;
  }
  const content = [
    { type: 'text', text: `Imagen generada: ${text}` },
    { type: 'image', source: { type: 'base64', media_type: res.mediaType, data: res.base64 }, fileName: `generada-${Date.now()}.jpg` },
  ];
  const r = await window.api.addMessage(currentConversationId, 'assistant', content);
  if (r && r.ok) {
    renderMessages(r.conversation.messages);
    refreshConversations();
  } else {
    alert('La imagen se generó pero no se pudo guardar en la conversación.');
  }
});

// ---------- Lectura en voz alta de respuestas ----------
let ttsEnabled = false;

function speakText(text) {
  if (!('speechSynthesis' in window) || !text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.slice(0, 4000));
  u.lang = 'es-MX';
  const voices = window.speechSynthesis.getVoices();
  const es = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('es'));
  if (es) u.voice = es;
  window.speechSynthesis.speak(u);
}

el('ttsBtn').addEventListener('click', async () => {
  ttsEnabled = !ttsEnabled;
  el('ttsBtn').classList.toggle('on', ttsEnabled);
  if (!ttsEnabled && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  await window.api.setConfig({ ttsEnabled });
});
el('sendBtn').addEventListener('click', () => {
  if (isStreaming) { window.api.cancelChat(); return; }
  runChat();
});

const API_KEY_HINT = {
  anthropic: 'Primero configura tu clave de API de Anthropic en Configuración.',
  openrouter: 'Primero configura tu clave de API de OpenRouter en Configuración.',
  custom: 'Primero configura tu clave de API del proveedor en Configuración.',
};

function setStreamingUI(streaming) {
  isStreaming = streaming;
  const btn = el('sendBtn');
  btn.classList.toggle('stopping', streaming);
  if (streaming) btn.innerHTML = '<svg class="ico ico-sm"><use href="#i-stop"></use></svg> Stop';
  else btn.innerHTML = 'Send <svg class="ico ico-sm"><use href="#i-arrow-up"></use></svg>';
  el('newChatBtn').disabled = streaming;
}

// Envío unificado: mensaje nuevo, editar y reenviar, o regenerar respuesta.
// mode: 'new' | 'edit' | 'regenerate'
async function runChat({ mode = 'new', truncateTo, newText } = {}) {
  if (isStreaming) return;

  const text = mode === 'new' ? textInput.value.trim() : String(newText || '').trim();
  if (mode === 'new' && !text && pendingAttachments.length === 0) return;

  const config = await window.api.getConfig();
  if (!config.apiKey) {
    alert(API_KEY_HINT[config.provider] || API_KEY_HINT.anthropic);
    openSettings();
    return;
  }

  if (!currentConversationId) {
    const convo = await window.api.createConversation();
    currentConversationId = convo.id;
  }

  // Actualiza el estado local y el DOM antes de llamar a la API.
  if (mode === 'new') {
    const content = text ? [{ type: 'text', text }] : pendingAttachments;
    appendBubble('user', content, currentMessages.length, null);
    currentMessages.push({ role: 'user', content });
  } else if (mode === 'edit') {
    const local = currentMessages.slice(0, truncateTo);
    local.push({ role: 'user', content: [{ type: 'text', text }] });
    renderMessages(local);
  } else if (mode === 'regenerate') {
    const local = currentMessages.slice();
    while (local.length && local[local.length - 1].role === 'assistant') local.pop();
    renderMessages(local);
  }

  const attachments = mode === 'new' ? pendingAttachments : [];
  if (mode === 'new') {
    pendingAttachments = [];
    renderAttachmentPreview();
    textInput.value = '';
    textInput.style.height = 'auto';
  }
  setStreamingUI(true);

  // Burbujas "en vivo": se van llenando a medida que llega el streaming.
  let thinkingAcc = '';
  let textAcc = '';
  const thinkingNode = document.createElement('div');
  thinkingNode.className = 'msg thinking hidden';
  const assistantNode = document.createElement('div');
  assistantNode.className = 'msg assistant';
  assistantNode.innerHTML = '<span class="typing-indicator">···</span>';
  messagesEl.appendChild(thinkingNode);
  messagesEl.appendChild(assistantNode);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const unsubscribe = window.api.onChatChunk((chunk) => {
    if (chunk.type === 'thinking') {
      thinkingAcc += chunk.text;
      thinkingNode.classList.remove('hidden');
      thinkingNode.innerHTML = renderMarkdownLite(thinkingAcc);
      enhanceCodeBlocks(thinkingNode);
    } else if (chunk.type === 'text') {
      textAcc += chunk.text;
      assistantNode.innerHTML = renderMarkdownLite(textAcc);
      enhanceCodeBlocks(assistantNode);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
  cancelCurrentStream = () => window.api.cancelChat();

  const result = await window.api.sendMessage({
    conversationId: currentConversationId,
    userText: mode === 'new' ? text : (mode === 'edit' ? text : null),
    attachments,
    thinkingMode: el('thinkingToggle').checked,
    skillId: el('skillSelect').value || null,
    truncateTo: mode === 'edit' ? truncateTo : undefined,
    regenerate: mode === 'regenerate' ? true : undefined,
  });

  unsubscribe();
  cancelCurrentStream = null;
  setStreamingUI(false);

  if (result.error === 'no-api-key') {
    renderMessages(currentMessages);
    appendBubble('error', 'Falta configurar tu clave de API.', -1, null);
    return;
  }
  if (result.error) {
    renderMessages(currentMessages);
    appendBubble('error', `Error al contactar la API: ${result.message}`, -1, null);
    return;
  }

  // Reconstruye todo desde lo guardado: garantiza acciones, tokens y markdown.
  renderMessages(result.conversation.messages);
  if (ttsEnabled && !result.stopped) {
    const lastAssistant = [...result.conversation.messages].reverse().find((m) => m.role === 'assistant');
    const txt = lastAssistant ? contentToText(lastAssistant.content) : '';
    if (txt) speakText(txt);
  }
  if (result.stopped) {
    const lastBubble = messagesEl.querySelector('.msg.assistant:last-of-type') ||
      [...messagesEl.querySelectorAll('.msg.assistant')].pop();
    if (lastBubble) {
      const tag = document.createElement('div');
      tag.className = 'stopped-tag';
      tag.textContent = '⏹ Generación detenida';
      lastBubble.appendChild(tag);
    }
  }
  refreshConversations();
}

// ---------- Configuración ----------
function openSettings() { el('settingsModal').classList.remove('hidden'); }
function closeSettings() { el('settingsModal').classList.add('hidden'); }

const PROVIDER_HINTS = {
  anthropic: { label: 'Clave de API de Anthropic', hint: 'La obtienes en console.anthropic.com. Usa el nombre exacto del modelo de Claude.', keyPlaceholder: 'sk-ant-...' },
  openrouter: { label: 'Clave de API de OpenRouter', hint: 'La obtienes en openrouter.ai/keys. El modelo se escribe como "proveedor/nombre", ej: anthropic/claude-sonnet-4.5, openai/gpt-4o, deepseek/deepseek-r1.', keyPlaceholder: 'sk-or-v1-...' },
  custom: { label: 'Clave de API del proveedor', hint: 'Debe ser un servicio compatible con el formato de "Chat Completions" de OpenAI (Groq, Together, un servidor local, etc). Escribe su URL base y el nombre del modelo tal como ese proveedor lo pide.', keyPlaceholder: 'tu clave aquí' },
};

function applyProviderUI(provider) {
  const info = PROVIDER_HINTS[provider] || PROVIDER_HINTS.anthropic;
  el('apiKeyLabel').textContent = info.label;
  el('apiKeyInput').placeholder = info.keyPlaceholder;
  el('providerHint').textContent = info.hint;
  el('providerHint').classList.remove('hidden');

  const isAnthropic = provider === 'anthropic';
  el('modelSelect').classList.toggle('hidden', !isAnthropic);
  el('modelFreeInput').classList.toggle('hidden', isAnthropic);
  el('baseUrlRow').classList.toggle('hidden', provider !== 'custom');
}

el('providerSelect').addEventListener('change', () => applyProviderUI(el('providerSelect').value));

el('settingsBtn').addEventListener('click', async () => {
  const config = await window.api.getConfig();
  const provider = config.provider || 'anthropic';
  el('providerSelect').value = provider;
  el('apiKeyInput').value = config.apiKey || '';
  el('baseUrlInput').value = config.baseUrl || '';
  if (provider === 'anthropic') {
    el('modelSelect').value = config.model || 'claude-sonnet-5';
  } else {
    el('modelFreeInput').value = config.model || '';
  }
  applyProviderUI(provider);
  el('globalPromptInput').value = config.globalSystemPrompt || '';
  el('temperatureInput').value = (config.temperature === null || config.temperature === undefined) ? '' : config.temperature;
  el('maxTokensInput').value = config.maxTokens || '';
  openSettings();
});
el('closeSettingsBtn').addEventListener('click', closeSettings);
el('saveSettingsBtn').addEventListener('click', async () => {
  const provider = el('providerSelect').value;
  const model = provider === 'anthropic' ? el('modelSelect').value : el('modelFreeInput').value.trim();
  const tempRaw = el('temperatureInput').value.trim();
  const maxRaw = el('maxTokensInput').value.trim();
  await window.api.setConfig({
    provider,
    apiKey: el('apiKeyInput').value.trim(),
    baseUrl: el('baseUrlInput').value.trim(),
    model,
    globalSystemPrompt: el('globalPromptInput').value.trim(),
    temperature: tempRaw === '' ? null : Number(tempRaw),
    maxTokens: maxRaw === '' ? null : Number(maxRaw),
  });
  populateQuickModels(await window.api.getConfig());
  updateContextMeter();
  closeSettings();
});

// ---------- Datos (exportar / importar) ----------
function flashDataStatus(msg, isError) {
  const p = el('dataStatus');
  p.textContent = msg;
  p.classList.toggle('error', !!isError);
  p.classList.remove('hidden');
  setTimeout(() => p.classList.add('hidden'), 5000);
}

el('exportBtn').addEventListener('click', async () => {
  const res = await window.api.exportData();
  if (res && res.ok) flashDataStatus(`Respaldo guardado en:\n${res.path}`);
  else if (res && !res.canceled) flashDataStatus('No se pudo exportar.', true);
});

el('importBtn').addEventListener('click', async () => {
  const res = await window.api.importData();
  if (res && res.ok) {
    flashDataStatus(`Importado: ${res.importedUsers} usuario(s).`);
    await refreshUsers();
    await refreshConversations();
  } else if (res && !res.canceled) {
    flashDataStatus(`Error al importar: ${res.error}`, true);
  }
});

// ---------- Skills ----------
let cachedSkills = [];

async function refreshSkills() {
  cachedSkills = await window.api.listSkills();
  const sel = el('skillSelect');
  const current = sel.value;
  sel.innerHTML = '<option value="">Sin skill</option>' +
    cachedSkills.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  if (current && cachedSkills.some((s) => s.id === current)) sel.value = current;
}

function openSkillsModal() { el('skillsModal').classList.remove('hidden'); refreshSkillsList(); }
function closeSkillsModal() { el('skillsModal').classList.add('hidden'); }

async function refreshSkillsList() {
  const list = await window.api.listSkills();
  const box = el('skillsList');
  box.innerHTML = list.length ? '' : '<p class="hint">Aún no tienes skills. Crea uno con "+ Nuevo skill".</p>';
  for (const s of list) {
    const item = document.createElement('div');
    item.className = 'skill-item' + (s.id === el('skillIdInput').value ? ' active' : '');
    item.innerHTML = `<div class="skill-meta"><div class="skill-name">${escapeHtml(s.name)}</div>` +
      (s.description ? `<div class="skill-desc">${escapeHtml(s.description)}</div>` : '') + '</div>' +
      '<span class="skill-del" title="Borrar"><svg class="ico ico-sm"><use href="#i-trash"></use></svg></span>';
    item.addEventListener('click', (e) => {
      if (e.target.closest('.skill-del')) return;
      el('skillIdInput').value = s.id;
      el('skillNameInput').value = s.name;
      el('skillDescInput').value = s.description || '';
      el('skillContentInput').value = s.content || '';
      refreshSkillsList();
    });
    item.querySelector('.skill-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`¿Borrar el skill "${s.name}"?`)) return;
      await window.api.deleteSkill(s.id);
      if (el('skillIdInput').value === s.id) el('skillIdInput').value = '';
      refreshSkillsList();
      refreshSkills();
    });
    box.appendChild(item);
  }
}

el('skillsBtn').addEventListener('click', openSkillsModal);
el('skillsCloseBtn').addEventListener('click', closeSkillsModal);
el('skillsNewBtn').addEventListener('click', () => {
  el('skillIdInput').value = '';
  el('skillNameInput').value = '';
  el('skillDescInput').value = '';
  el('skillContentInput').value = '';
  refreshSkillsList();
  el('skillNameInput').focus();
});
el('skillsSaveBtn').addEventListener('click', async () => {
  const name = el('skillNameInput').value.trim();
  const content = el('skillContentInput').value.trim();
  if (!name) { alert('Escribe un nombre para el skill.'); return; }
  if (!content) { alert('Escribe la instrucción del skill.'); return; }
  const data = { name, description: el('skillDescInput').value.trim(), content };
  const id = el('skillIdInput').value;
  if (id) {
    await window.api.updateSkill(id, data);
  } else {
    const created = await window.api.createSkill(data);
    el('skillIdInput').value = created.id;
  }
  await refreshSkills();
  refreshSkillsList();
});
el('skillsDeleteBtn').addEventListener('click', async () => {
  const id = el('skillIdInput').value;
  if (!id) { alert('Selecciona un skill para borrar.'); return; }
  if (!confirm('¿Borrar este skill?')) return;
  await window.api.deleteSkill(id);
  el('skillIdInput').value = '';
  el('skillNameInput').value = '';
  el('skillDescInput').value = '';
  el('skillContentInput').value = '';
  await refreshSkills();
  refreshSkillsList();
});

// ---------- Agente ----------
let agentRunning = false;
let agentUnsubEvent = null;
let agentUnsubApproval = null;

function agentLogStep(cls, text) {
  const log = el('agentLog');
  log.classList.remove('hidden');
  const step = document.createElement('div');
  step.className = 'agent-step ' + cls;
  step.textContent = text;
  log.appendChild(step);
  log.scrollTop = log.scrollHeight;
}

function setAgentRunningUI(running) {
  agentRunning = running;
  const startBtn = el('agentStartBtn');
  startBtn.disabled = running;
  if (running) startBtn.innerHTML = '<span class="ico ico-sm spin" aria-hidden="true"><svg class="ico ico-sm"><use href="#i-refresh"></use></svg></span> En curso…';
  else startBtn.innerHTML = '<svg class="ico ico-sm"><use href="#i-play"></use></svg> Ejecutar';
  el('agentCloseBtn').textContent = running ? 'Cancelar y cerrar' : 'Cerrar';
  el('agentApproval').classList.add('hidden');
}

async function openAgentModal() {
  el('agentModal').classList.remove('hidden');
  const ws = await window.api.agentWorkspace();
  el('agentWorkspaceLabel').textContent = ws || '(sin carpeta)';
}

function closeAgentModal() {
  if (agentRunning) window.api.agentCancel();
  if (agentUnsubEvent) { agentUnsubEvent(); agentUnsubEvent = null; }
  if (agentUnsubApproval) { agentUnsubApproval(); agentUnsubApproval = null; }
  setAgentRunningUI(false);
  el('agentModal').classList.add('hidden');
}

el('agentBtn').addEventListener('click', openAgentModal);
el('agentCloseBtn').addEventListener('click', closeAgentModal);

el('agentChangeWsBtn').addEventListener('click', async () => {
  const ws = await window.api.agentSetWorkspace();
  if (ws) el('agentWorkspaceLabel').textContent = ws;
});

el('agentApproveBtn').addEventListener('click', () => {
  el('agentApproval').classList.add('hidden');
  window.api.agentResolve(true);
});
el('agentDenyBtn').addEventListener('click', () => {
  el('agentApproval').classList.add('hidden');
  window.api.agentResolve(false);
});

el('agentStartBtn').addEventListener('click', async () => {
  const task = el('agentTaskInput').value.trim();
  if (!task) { alert('Escribe la tarea que quieres que haga el agente.'); return; }

  const config = await window.api.getConfig();
  if (!config.apiKey) {
    alert(API_KEY_HINT[config.provider] || API_KEY_HINT.anthropic);
    openSettings();
    return;
  }

  el('agentLog').innerHTML = '';
  setAgentRunningUI(true);
  agentLogStep('done', '▶ Agente iniciado: ' + task);

  agentUnsubEvent = window.api.onAgentEvent((evt) => {
    if (evt.type === 'assistant' && evt.content) agentLogStep('assistant', '🤖 ' + evt.content);
    else if (evt.type === 'tool_request') agentLogStep('tool-req', `🔧 ${evt.name}: ${JSON.stringify(evt.input, null, 1)}`);
    else if (evt.type === 'tool_result') agentLogStep(evt.ok ? 'tool-ok' : 'tool-err', (evt.ok ? '✓ ' : '✗ ') + (evt.output || ''));
  });
  agentUnsubApproval = window.api.onAgentApproval((payload) => {
    el('agentApprovalDetail').textContent = `${payload.name}\n${JSON.stringify(payload.input, null, 2)}`;
    el('agentApproval').classList.remove('hidden');
  });

  const result = await window.api.agentRun(task, config.agentSystemPrompt || null);

  if (agentUnsubEvent) { agentUnsubEvent(); agentUnsubEvent = null; }
  if (agentUnsubApproval) { agentUnsubApproval(); agentUnsubApproval = null; }
  setAgentRunningUI(false);

  if (result.error === 'no-api-key') {
    agentLogStep('tool-err', 'Falta configurar tu clave de API.');
  } else if (result.error) {
    agentLogStep('tool-err', 'Error: ' + result.error);
  } else if (result.stopped) {
    agentLogStep('cancel', '⏹ Agente detenido.');
  } else {
    agentLogStep('done', '✔ Agente terminado.');
  }
});

// ---------- Plugins ----------
async function refreshPlugins() {
  const data = await window.api.pluginsList();
  el('pluginsDirLabel').textContent = data.pluginsDir;
  const box = el('pluginsList');
  box.innerHTML = data.plugins.length ? '' : '<p class="hint">No hay plugins en la carpeta. Crea una subcarpeta con plugin.json e index.js.</p>';
  for (const p of data.plugins) {
    const item = document.createElement('div');
    item.className = 'skill-item plugin-item';
    item.innerHTML = `<div class="plugin-info"><div class="plugin-name">${escapeHtml(p.name)} <span class="hint">v${escapeHtml(p.version || '?')}</span></div>` +
      `<div class="plugin-desc">${escapeHtml(p.description || '')}</div></div>` +
      `<label><input type="checkbox" ${p.enabled ? 'checked' : ''}/> Activo</label>`;
    item.querySelector('input').addEventListener('change', async (e) => {
      await window.api.pluginsToggle(p.id, e.target.checked);
    });
    box.appendChild(item);
  }
}

el('pluginsBtn').addEventListener('click', async () => {
  el('pluginsModal').classList.remove('hidden');
  await refreshPlugins();
});
el('pluginsCloseBtn').addEventListener('click', () => el('pluginsModal').classList.add('hidden'));
el('pluginsReloadBtn').addEventListener('click', async () => {
  await window.api.pluginsReload();
  await refreshPlugins();
});

// ---------- Buscador, atajos y exportación ----------
el('convoSearch').addEventListener('input', () => refreshConversations());

async function exportCurrentConversation() {
  if (isStreaming) return;
  if (!currentConversationId) { alert('Abre una conversación para exportarla.'); return; }
  const res = await window.api.exportConversation(currentConversationId);
  if (res && res.ok) {
    const btn = el('exportConvoBtn');
    const old = btn.innerHTML;
    btn.innerHTML = '<svg class="ico"><use href="#i-check"></use></svg>';
    btn.style.color = 'var(--accent)';
    setTimeout(() => { btn.innerHTML = old; btn.style.color = ''; }, 2000);
  } else if (res && res.error !== 'canceled') {
    alert('No se pudo exportar: ' + (res.message || res.error));
  }
}
el('exportConvoBtn').addEventListener('click', exportCurrentConversation);

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === 'n') { e.preventDefault(); if (!isStreaming) el('newChatBtn').click(); }
  else if (e.key === ',') { e.preventDefault(); el('settingsBtn').click(); }
  else if (e.shiftKey && (e.key === 'S' || e.key === 's')) { e.preventDefault(); exportCurrentConversation(); }
});

window.api.onConversationsChanged((payload) => {
  refreshConversations();
  if (payload && payload.id === currentConversationId && payload.title) {
    setProjectName(payload.title);
  }
});

// ---------- Actualizaciones (electron-updater) ----------
let updateDownloaded = false;
window.api.onUpdateEvent((evt) => {
  const banner = el('updateBanner');
  const text = el('updateText');
  const bar = el('updateBar');
  const track = el('updateTrack');
  const btn = el('updateInstallBtn');
  if (!banner || !evt) return;
  if (evt.type === 'available') {
    updateDownloaded = false;
    banner.hidden = false;
    track.hidden = false;
    btn.hidden = true;
    bar.style.width = '0%';
    text.textContent = `Nueva versión v${evt.version} — descargando…`;
  } else if (evt.type === 'progress') {
    const p = Math.min(100, Math.round(evt.percent || 0));
    banner.hidden = false;
    if (!updateDownloaded) track.hidden = false;
    text.textContent = updateDownloaded
      ? text.textContent
      : `Descargando actualización… ${p}%`;
    bar.style.width = p + '%';
  } else if (evt.type === 'downloaded') {
    updateDownloaded = true;
    banner.hidden = false;
    track.hidden = true;
    btn.hidden = false;
    text.textContent = `v${evt.version} lista — reinicia para instalarla`;
  } else if (evt.type === 'not-available' || evt.type === 'error') {
    if (evt.type === 'error') console.warn('Updater:', evt.message);
    if (!updateDownloaded) banner.hidden = true;
  }
});
  el('updateInstallBtn').innerHTML = '<svg class="ico ico-sm"><use href="#i-refresh"></use></svg> Reiniciar para actualizar';

// ---------- Modelo rápido + medidor de contexto ----------
const COMMON_MODELS = [
  'anthropic/claude-sonnet-4.5', 'anthropic/claude-opus-4.1', 'anthropic/claude-haiku-4',
  'openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/o4-mini',
  'google/gemini-2.0-flash-001', 'deepseek/deepseek-r1', 'meta-llama/llama-3.3-70b-instruct',
];

function populateQuickModels(config) {
  const cur = config.model || '';
  el('quickModelInput').value = cur;
  const models = config.provider === 'anthropic'
    ? [...el('modelSelect').options].map((o) => o.value)
    : COMMON_MODELS;
  const all = [...new Set([cur, ...models])].filter(Boolean);
  const dl = el('quickModelList');
  dl.innerHTML = '';
  for (const m of all) {
    const o = document.createElement('option');
    o.value = m;
    dl.appendChild(o);
  }
}

async function applyQuickModel() {
  const val = el('quickModelInput').value.trim();
  const config = await window.api.getConfig();
  if (!val) { populateQuickModels(config); return; }
  if (config.model === val) return;
  await window.api.setConfig({ model: val });
  populateQuickModels({ ...config, model: val });
  updateContextMeter();
}
el('quickModelInput').addEventListener('change', applyQuickModel);
el('quickModelInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyQuickModel(); textInput.focus(); }
});

function getModelLimit(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('claude')) return 200000;
  if (m.includes('gemini')) return 1000000;
  if (m.includes('gpt-4o') || m.includes('gpt-4.1') || m.includes('o4')) return 128000;
  if (m.includes('gpt-3.5')) return 16385;
  if (m.includes('deepseek')) return 64000;
  if (m.includes('llama')) return 131072;
  return 128000;
}

function estimateTokensOfMessages(msgs) {
  let chars = 0;
  for (const m of msgs) chars += contentToText(m.content).length + (m.thinking ? m.thinking.length : 0);
  return Math.ceil(chars / 4) + 200;
}

async function updateContextMeter() {
  const meter = el('contextMeter');
  if (!currentMessages.length) { meter.classList.add('hidden'); return; }
  const config = await window.api.getConfig();
  const limit = getModelLimit(config.model);
  // Si el último mensaje es la respuesta con uso real de tokens, usa ese número
  // exacto; si no (hubo ediciones/borrados), estima ~4 caracteres por token.
  const last = currentMessages[currentMessages.length - 1];
  const lastWithUsage = [...currentMessages].reverse().find((m) => m.role === 'assistant' && m.usage && m.usage.input);
  const used = (lastWithUsage === last) ? lastWithUsage.usage.input : estimateTokensOfMessages(currentMessages);
  const pct = Math.min(100, Math.max(1, (used / limit) * 100));
  const fill = meter.querySelector('.meter-fill');
  fill.style.width = pct + '%';
  fill.className = 'meter-fill' + (pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : '');
  const fmt = (n) => Number(n).toLocaleString('es-MX');
  meter.querySelector('.meter-text').textContent = `${fmt(used)} / ${fmt(limit)} tok`;
  meter.classList.remove('hidden');
}

// ---------- Tema claro / oscuro ----------
function applyTheme(theme) {
  const light = theme === 'light';
  document.body.classList.toggle('light', light);
  el('themeBtn').innerHTML = light
    ? '<svg class="ico"><use href="#i-moon"></use></svg>'
    : '<svg class="ico"><use href="#i-sun"></use></svg>';
  el('themeBtn').title = light ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro';
}
el('themeBtn').addEventListener('click', async () => {
  const cfg = await window.api.getConfig();
  const next = cfg.theme === 'light' ? 'dark' : 'light';
  await window.api.setConfig({ theme: next });
  applyTheme(next);
});

// ---------- Pegar imágenes desde el portapapeles (Ctrl+V) ----------
document.addEventListener('paste', async (e) => {
  if (!e.clipboardData || !e.clipboardData.items) return;
  const item = [...e.clipboardData.items].find((it) => it.kind === 'file' && it.type.startsWith('image/'));
  if (!item) return; // texto plano: se pega normalmente
  const file = item.getAsFile();
  if (!file) return;
  e.preventDefault();
  if (file.size > 10 * 1024 * 1024) { alert('Imagen muy grande (máximo 10 MB).'); return; }
  const dataUrl = await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(file);
  });
  const b64 = String(dataUrl).split(',')[1] || '';
  const mime = file.type || 'image/png';
  pendingAttachments.push({
    kind: 'image',
    fileName: `pegado-${Date.now()}.${(mime.split('/')[1] || 'png').replace('jpeg', 'jpg')}`,
    mediaType: mime,
    base64: b64,
    sizeBytes: file.size,
  });
  renderAttachmentPreview();
  textInput.focus();
});

// ---------- Vistas del riel: chat, búsqueda web, equipo, historial ----------
const VIEW_LABELS = { web: 'Búsqueda Web', team: 'Espacio de Equipo', history: 'Historial de Actividad' };

function setMainView(view) {
  currentView = view;
  document.querySelectorAll('.rail-btn[data-nav]').forEach((b) =>
    b.classList.toggle('active', b.dataset.nav === view));
  el('chatView').classList.toggle('hidden', view !== 'chats');
  el('webView').classList.toggle('hidden', view !== 'web');
  el('teamView').classList.toggle('hidden', view !== 'team');
  el('historyView').classList.toggle('hidden', view !== 'history');
  // El selector de modelo / medidor / exportar solo aplica al chat.
  el('wsRight').classList.toggle('hidden', view !== 'chats');
  if (view === 'chats') {
    const c = convosCache.find((x) => x.id === currentConversationId);
    setProjectName(c ? c.title : null);
  } else {
    el('titlebarProject').textContent = VIEW_LABELS[view];
    el('crumbProject').textContent = VIEW_LABELS[view];
  }
  if (view === 'web') { el('webSearchInput').focus(); }
  else if (view === 'team') refreshTeam();
  else if (view === 'history') refreshStats();
}

// ===== Búsqueda web =====
function renderWebResults(res) {
  const box = el('webResults');
  box.innerHTML = '';
  if (!res.ok) {
    box.innerHTML = `<p class="hint">No se pudo buscar: ${escapeHtml(res.error || 'error desconocido')}.</p>`;
    return;
  }
  if (!res.results.length) {
    box.innerHTML = '<p class="hint">Sin resultados. Prueba con otras palabras.</p>';
    return;
  }
  for (const r of res.results) {
    const item = document.createElement('div');
    item.className = 'web-result';
    item.innerHTML =
      `<div class="web-result-title"><svg class="ico"><use href="#i-link"></use></svg>${escapeHtml(r.title || '(sin título)')}</div>` +
      (r.snippet ? `<p class="web-result-snippet">${escapeHtml(r.snippet)}</p>` : '') +
      `<div class="web-result-foot">` +
      `<span class="web-result-meta"><span class="src">${escapeHtml(r.source || 'web')}</span>` +
      (r.url ? `<span class="url">${escapeHtml(r.url)}</span>` : '') + `</span>` +
      `<span class="web-result-actions">` +
      `<button class="web-result-use" data-url="${escapeHtml(r.url || '')}" data-title="${escapeHtml(r.title || '')}" data-snippet="${escapeHtml(r.snippet || '')}">` +
      `<svg class="ico"><use href="#i-plus"></use></svg>Usar en el chat</button>` +
      `</span></div>`;
    box.appendChild(item);
  }
}

function runWebSearch() {
  const q = el('webSearchInput').value.trim();
  if (!q) return;
  const btn = el('webSearchBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="ico ico-sm spin"><svg class="ico ico-sm"><use href="#i-refresh"></use></svg></span> Buscando…';
  window.api.webSearch(q).then((res) => {
    renderWebResults(res);
  }).finally(() => {
    btn.disabled = false;
    btn.innerHTML = '<svg class="ico ico-sm"><use href="#i-search"></use></svg> Buscar';
  });
}

el('webSearchBtn').addEventListener('click', runWebSearch);
el('webSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runWebSearch(); }
});
// Inserta el resultado elegido como contexto en el chat y vuelve a la vista de chat.
el('webResults').addEventListener('click', (e) => {
  const btn = e.target.closest('.web-result-use');
  if (!btn) return;
  const { title, url, snippet } = btn.dataset;
  const block = `[Contexto web — ${title}](${url})\n${snippet || ''}`.trim();
  textInput.value = (textInput.value ? textInput.value.trim() + '\n\n' : '') + block;
  textInput.dispatchEvent(new Event('input'));
  setMainView('chats');
  textInput.focus();
});

// ===== Espacio de equipo (espacios de trabajo = usuarios) =====
async function refreshTeam() {
  const users = await window.api.listUsers();
  const current = await window.api.getCurrentUser();
  const list = el('teamList');
  list.innerHTML = '';
  for (const u of users) {
    const item = document.createElement('div');
    item.className = 'team-item' + (u.id === current.id ? ' active' : '');
    const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '';
    item.innerHTML =
      `<div class="team-avatar">${escapeHtml((u.name.trim().charAt(0) || '?').toUpperCase())}</div>` +
      `<div class="team-body">` +
      `<div class="team-name">${escapeHtml(u.name)}${u.id === current.id ? ' <span class="team-badge">ACTIVO</span>' : ''}</div>` +
      `<div class="team-meta">${created ? 'Creado ' + escapeHtml(created) : ''}${u.hasPassword ? ' · con contraseña' : ''}</div>` +
      `</div>` +
      `<div class="team-item-actions">` +
      (u.id === current.id ? '' : `<button class="team-btn use" data-id="${u.id}" data-name="${escapeHtml(u.name)}">Cambiar</button>`) +
      `<button class="team-btn ren" data-id="${u.id}" data-name="${escapeHtml(u.name)}">Renombrar</button>` +
      (u.id === current.id ? '' : `<button class="team-btn danger del" data-id="${u.id}" data-name="${escapeHtml(u.name)}">Eliminar</button>`) +
      `</div>`;
    list.appendChild(item);
  }
}

async function switchToSpace(id, name, password) {
  const result = await window.api.switchUser(id, password || null);
  if (!result.ok) return result;
  await refreshUsers();
  await refreshConversations();
  await refreshSkills();
  clearChat();
  refreshTeam();
  return result;
}

el('teamList').addEventListener('click', async (e) => {
  const btn = e.target.closest('.team-btn');
  if (!btn) return;
  const { id, name } = btn.dataset;
  if (btn.classList.contains('use')) {
    const users = await window.api.listUsers();
    const target = users.find((u) => u.id === id);
    let password = null;
    if (target && target.hasPassword) {
      const res = await askPassword({ title: `Contraseña de ${target.name}`, newLabel: 'Contraseña' });
      if (!res) return;
      password = res.next;
    }
    const result = await switchToSpace(id, name, password);
    if (!result.ok) alert('Contraseña incorrecta.');
  } else if (btn.classList.contains('ren')) {
    const nuevo = prompt('Nuevo nombre del espacio:', name);
    if (nuevo === null) return;
    const trimmed = nuevo.trim();
    if (!trimmed) return;
    await window.api.renameUser(id, trimmed);
    await refreshUsers();
    refreshTeam();
  } else if (btn.classList.contains('del')) {
    if (!confirm(`¿Eliminar el espacio "${name}" y todos sus datos? Esta acción no se puede deshacer.`)) return;
    const res = await window.api.deleteUser(id);
    if (!res.ok && res.error === 'is-current') {
      alert('No puedes eliminar el espacio activo. Cambia a otro espacio primero.');
      return;
    }
    refreshTeam();
  }
});

el('teamNewBtn').addEventListener('click', async () => {
  const name = prompt('Nombre del nuevo espacio de trabajo:');
  if (!name || !name.trim()) return;
  const res = await askPassword({
    title: `Contraseña para "${name.trim()}" (opcional)`,
    newLabel: 'Contraseña (déjalo vacío para no usar una)',
    allowEmpty: true,
  });
  if (res === null) return;
  await window.api.createUser(name.trim(), res.next || undefined);
  await refreshUsers();
  await refreshConversations();
  await refreshSkills();
  clearChat();
  refreshTeam();
});

// ===== Historial / estadísticas =====
async function refreshStats() {
  const s = await window.api.getStats();
  const fmt = (n) => Number(n || 0).toLocaleString('es-MX');
  const grid = el('statsGrid');
  const cards = [
    { v: fmt(s.conversations), l: 'Conversaciones', accent: true },
    { v: fmt(s.messages), l: 'Mensajes enviados' },
    { v: fmt(s.tokensInput + s.tokensOutput), l: 'Tokens usados (↑+↓)' },
    { v: fmt(s.skills), l: 'Skills guardados' },
    { v: fmt(s.folders), l: 'Carpetas' },
    { v: fmt(s.spaces), l: 'Espacios de trabajo' },
    { v: fmt(s.attachments), l: 'Adjuntos (imágenes/docs)' },
    { v: s.lastActivity ? new Date(s.lastActivity).toLocaleString() : '—', l: 'Última actividad', wide: true },
    { v: s.firstActivity ? new Date(s.firstActivity).toLocaleString() : '—', l: 'Primera actividad', wide: true },
  ];
  grid.innerHTML = cards.map((c) =>
    `<div class="stat-card${c.wide ? ' stat-wide' : ''}">` +
    `<div class="stat-value${c.accent ? ' accent' : ''}">${c.v}</div>` +
    `<div class="stat-label">${c.l}</div></div>`).join('');
}

el('statsRefreshBtn').addEventListener('click', refreshStats);

// ---------- Nueva UI: titlebar, riel, dock y menús ----------
el('winCloseBtn').addEventListener('click', () => window.api.windowControl('close'));
el('winMinBtn').addEventListener('click', () => window.api.windowControl('minimize'));
el('winMaxBtn').addEventListener('click', () => window.api.windowControl('maximize'));

document.querySelectorAll('.rail-btn[data-nav]').forEach((btn) => {
  btn.addEventListener('click', () => setMainView(btn.dataset.nav));
});

document.querySelector('.quick-note-btn')?.addEventListener('click', () => el('newChatBtn').click());

el('modelPill').addEventListener('click', () => {
  const inp = el('quickModelInput');
  inp.focus();
  inp.select();
});

el('micBtn').addEventListener('click', () => toast('Dictado por voz: pulsa Win+H en Windows.'));

// Menú del dock (skills y complementos)
const dockMenu = el('dockMenu');
el('skillsDockBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = dockMenu.classList.toggle('hidden');
  el('skillsDockBtn').setAttribute('aria-expanded', String(!open));
  if (!open) el('userMenu').classList.add('hidden');
});
dockMenu.addEventListener('click', (e) => e.stopPropagation());

// Menú de perfil / usuarios
el('profileBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = el('userMenu').classList.toggle('hidden');
  el('profileBtn').setAttribute('aria-expanded', String(!open));
  if (!open) dockMenu.classList.add('hidden');
});
el('userMenu').addEventListener('click', (e) => e.stopPropagation());
el('logoutBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  el('userMenu').classList.remove('hidden');
  el('profileBtn').setAttribute('aria-expanded', 'true');
  dockMenu.classList.add('hidden');
});

document.addEventListener('click', () => {
  dockMenu.classList.add('hidden');
  el('skillsDockBtn').setAttribute('aria-expanded', 'false');
  el('userMenu').classList.add('hidden');
  el('profileBtn').setAttribute('aria-expanded', 'false');
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    dockMenu.classList.add('hidden');
    el('userMenu').classList.add('hidden');
    el('skillsDockBtn').setAttribute('aria-expanded', 'false');
    el('profileBtn').setAttribute('aria-expanded', 'false');
  }
});

// Tarjetas bento de bienvenida
document.querySelectorAll('.bento-card').forEach((card) => {
  card.addEventListener('click', () => {
    if (isStreaming) return;
    textInput.value = card.dataset.prompt || '';
    textInput.dispatchEvent(new Event('input'));
    textInput.focus();
    runChat();
  });
});

// ---------- Arranque ----------
(async function start() {
  await refreshUsers();
  await refreshConversations();
  await refreshSkills();
  clearChat();
  const config = await window.api.getConfig();
  applyTheme(config.theme === 'light' ? 'light' : 'dark');
  populateQuickModels(config);
  ttsEnabled = !!config.ttsEnabled;
  el('ttsBtn').classList.toggle('on', ttsEnabled);
  if (!config.apiKey) openSettings();
})();
