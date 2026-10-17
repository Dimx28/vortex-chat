const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./src/lib/store');
const { sendMessage, PROVIDER_PRESETS } = require('./src/lib/apiClient');
const { runAgent } = require('./src/lib/agent');
const pluginHost = require('./src/lib/pluginHost');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let activeAbortController = null;

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: 'Vortex Chat',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
}

app.whenReady().then(() => {
  store.init(app.getPath('userData'));
  pluginHost.init(__dirname);
  pluginHost.loadEnabled(store.getConfig().enabledPlugins || {});
  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- Actualizaciones automáticas (electron-updater + GitHub Releases) ----
function setupAutoUpdater() {
  if (!app.isPackaged) return; // en desarrollo no existe app-update.yml
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) =>
    sendToRenderer('update:event', { type: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () =>
    sendToRenderer('update:event', { type: 'not-available' }));
  autoUpdater.on('download-progress', (p) =>
    sendToRenderer('update:event', { type: 'progress', percent: p.percent, transferred: p.transferred, total: p.total }));
  autoUpdater.on('update-downloaded', (info) =>
    sendToRenderer('update:event', { type: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) =>
    sendToRenderer('update:event', { type: 'error', message: String((err && err.message) || err) }));
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 5000);
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4 * 60 * 60 * 1000);
}

ipcMain.handle('updater:check', () => {
  if (!app.isPackaged) return { dev: true };
  autoUpdater.checkForUpdates().catch(() => {});
  return { ok: true };
});
ipcMain.handle('updater:install', () => {
  autoUpdater.quitAndInstall(false, true);
});

// ---- Configuración (clave de API, modelo) ----
ipcMain.handle('config:get', () => store.getConfig());
ipcMain.handle('config:set', (_evt, partial) => store.setConfig(partial));
ipcMain.handle('config:providers', () => PROVIDER_PRESETS);

// ---- Usuarios (perfiles locales, con contraseña opcional) ----
ipcMain.handle('users:list', () => store.listUsers());
ipcMain.handle('users:create', (_evt, name, password) => store.createUser(name, password));
ipcMain.handle('users:switch', (_evt, userId, password) => store.switchUser(userId, password));
ipcMain.handle('users:current', () => store.getCurrentUser());
ipcMain.handle('users:setPassword', (_evt, userId, currentPassword, newPassword) =>
  store.setUserPassword(userId, currentPassword, newPassword));

// ---- Conversaciones ----
ipcMain.handle('conversations:list', () => store.listConversations());
ipcMain.handle('conversations:load', (_evt, id) => store.loadConversation(id));
ipcMain.handle('conversations:create', () => store.createConversation());
ipcMain.handle('conversations:delete', (_evt, id) => store.deleteConversation(id));
ipcMain.handle('conversations:rename', (_evt, id, title) => store.renameConversation(id, title));
ipcMain.handle('conversations:setFolder', (_evt, id, folderId) => store.setConversationFolder(id, folderId));

ipcMain.handle('folders:list', () => store.listFolders());
ipcMain.handle('folders:create', (_evt, name) => store.createFolder(name));
ipcMain.handle('folders:rename', (_evt, id, name) => store.renameFolder(id, name));
ipcMain.handle('folders:delete', (_evt, id) => store.deleteFolder(id));

// ---- Skills (plantillas de instrucciones por usuario) ----
ipcMain.handle('skills:list', () => store.listSkills());
ipcMain.handle('skills:get', (_evt, id) => store.getSkill(id));
ipcMain.handle('skills:create', (_evt, data) => store.createSkill(data));
ipcMain.handle('skills:update', (_evt, id, partial) => store.updateSkill(id, partial));
ipcMain.handle('skills:delete', (_evt, id) => store.deleteSkill(id));

// ---- Agente (herramientas con aprobación paso a paso) ----
let agentApprovalResolver = null;

function getAgentWorkspace() {
  const cfg = store.getConfig();
  const ws = cfg.agentWorkspace || path.join(app.getPath('documents'), 'VortexAgente');
  try { fs.mkdirSync(ws, { recursive: true }); } catch { /* si no se puede crear, se avisará al ejecutar */ }
  return ws;
}

ipcMain.handle('agent:workspace', () => getAgentWorkspace());

ipcMain.handle('agent:setWorkspace', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  store.setConfig({ agentWorkspace: result.filePaths[0] });
  return result.filePaths[0];
});

ipcMain.handle('agent:run', async (_evt, { task, systemPrompt }) => {
  const config = store.getConfig();
  if (!config.apiKey) return { error: 'no-api-key' };

  const workspace = getAgentWorkspace();
  activeAbortController = new AbortController();

  try {
    const result = await runAgent({
      config,
      messages: [{ role: 'user', content: task }],
      systemPrompt: (systemPrompt ? systemPrompt + '\n\n' : '') +
        'Eres un agente de escritorio con acceso limitado al área de trabajo: ' + workspace +
        '. Usa las herramientas para leer, escribir y ejecutar comandos. Pide aprobación para cada acción.',
      workspace,
      signal: activeAbortController.signal,
      onEvent: (evt) => sendToRenderer('agent:event', evt),
      requestApproval: (name, input) => new Promise((resolve) => {
        agentApprovalResolver = resolve;
        sendToRenderer('agent:approval', { name, input });
      }),
    });
    return { ok: true, ...result };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: true, stopped: true, content: '' };
    return { error: err.message || String(err) };
  } finally {
    agentApprovalResolver = null;
    activeAbortController = null;
  }
});

ipcMain.handle('agent:resolve', (_evt, decision) => {
  if (agentApprovalResolver) {
    const r = agentApprovalResolver;
    agentApprovalResolver = null;
    r(decision); // true | false | 'cancel'
  }
});

ipcMain.handle('agent:cancel', () => {
  if (agentApprovalResolver) {
    const r = agentApprovalResolver;
    agentApprovalResolver = null;
    r('cancel');
  }
  if (activeAbortController) activeAbortController.abort();
});

// ---- Plugins locales (carpeta plugins/) ----
ipcMain.handle('plugins:list', () => {
  const enabledMap = store.getConfig().enabledPlugins || {};
  const loaded = pluginHost.listPlugins().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    version: p.version,
    enabled: Boolean(enabledMap[p.id]),
  }));
  return { pluginsDir: path.join(__dirname, 'plugins'), plugins: loaded };
});
ipcMain.handle('plugins:toggle', (_evt, id, enabled) => {
  const cfg = store.getConfig();
  const enabledMap = { ...(cfg.enabledPlugins || {}) };
  if (enabled) enabledMap[id] = true;
  else delete enabledMap[id];
  store.setConfig({ enabledPlugins: enabledMap });
  pluginHost.loadEnabled(enabledMap);
  return true;
});
ipcMain.handle('plugins:reload', () => {
  pluginHost.loadEnabled(store.getConfig().enabledPlugins || {});
  return true;
});

// ---- Adjuntar archivo (imagen o documento) ----
ipcMain.handle('files:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Imágenes y documentos', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const data = fs.readFileSync(filePath);

  if (data.length > MAX_ATTACHMENT_BYTES) {
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Archivo demasiado grande',
      message: `"${fileName}" pesa ${(data.length / (1024 * 1024)).toFixed(1)} MB.`,
      detail: 'El límite por archivo adjunto es 10 MB.',
    });
    return null;
  }

  const base64 = data.toString('base64');

  const mimeMap = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  };
  const mediaType = mimeMap[ext] || 'application/octet-stream';
  const kind = mediaType.startsWith('image/') ? 'image' : (mediaType === 'application/pdf' ? 'document' : 'text');

  return { fileName, mediaType, kind, base64, sizeBytes: data.length };
});

// ---- Enviar mensaje (también regenerar / editar y reenviar) ----
ipcMain.handle('chat:send', async (_evt, { conversationId, userText, attachments, thinkingMode, skillId, truncateTo, regenerate }) => {
  const config = store.getConfig();
  if (!config.apiKey) {
    return { error: 'no-api-key' };
  }

  const convo = store.loadConversation(conversationId);
  if (!convo) return { error: 'not-found' };

  // Skill activo + prompt global: juntos forman la instrucción de sistema.
  let skillContent = null;
  if (skillId) {
    const skill = store.getSkill(skillId);
    if (skill && skill.content) {
      skillContent = skill.content;
      convo.skillId = skill.id;
      convo.skillName = skill.name;
    }
  } else {
    delete convo.skillId;
    delete convo.skillName;
  }
  const systemPrompt = [config.globalSystemPrompt, skillContent].filter(Boolean).join('\n\n') || null;

  // Primer intercambio: sirve para generar el título con IA después.
  const wasFirstExchange = convo.messages.length === 0;

  if (regenerate) {
    // Quita la respuesta final del asistente (el thinking viaja en el mismo mensaje).
    while (convo.messages.length && convo.messages[convo.messages.length - 1].role === 'assistant') {
      convo.messages.pop();
    }
  } else if (typeof truncateTo === 'number') {
    // Editar y reenviar: corta el historial y agrega el mensaje corregido.
    convo.messages = convo.messages.slice(0, truncateTo);
    const hookedText = await pluginHost.runHookAsync('beforeSend', userText, { conversationId, provider: config.provider });
    convo.messages.push(store.buildUserMessage(hookedText, []));
  } else {
    // Hook de plugin: permite transformar el texto del usuario antes de enviarlo.
    const hookedText = await pluginHost.runHookAsync('beforeSend', userText, { conversationId, provider: config.provider });
    convo.messages.push(store.buildUserMessage(hookedText, attachments));
  }

  activeAbortController = new AbortController();

  try {
    const reply = await sendMessage({
      provider: config.provider || 'anthropic',
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      messages: convo.messages,
      thinkingMode,
      systemPrompt,
      temperature: config.temperature,
      maxTokens: config.maxTokens || undefined,
      signal: activeAbortController.signal,
      onChunk: (chunk) => sendToRenderer('chat:chunk', chunk),
    });

    if (reply.stopped) {
      // Guarda lo que sí alcanzó a generarse antes de detenerse.
      if (reply.content || reply.thinking) {
        convo.messages.push({ role: 'assistant', content: reply.content || '', thinking: reply.thinking || null, usage: reply.usage || null });
      }
      store.saveConversation(convo);
      if (wasFirstExchange && !regenerate) maybeGenerateTitle(convo.id, config, convo.messages);
      return { ok: true, stopped: true, conversation: convo };
    }

    // Hook de plugin: permite transformar la respuesta antes de guardarse.
    // (El texto en vivo del streaming es la salida cruda del modelo.)
    reply.content = await pluginHost.runHookAsync('afterReceive', reply.content, { conversationId, provider: config.provider });

    convo.messages.push({ role: 'assistant', content: reply.content, thinking: reply.thinking || null, usage: reply.usage || null });
    store.saveConversation(convo);
    if (wasFirstExchange && !regenerate) maybeGenerateTitle(convo.id, config, convo.messages);
    return { ok: true, conversation: convo };
  } catch (err) {
    // Guarda el mensaje del usuario aunque falle la respuesta, para no perderlo
    store.saveConversation(convo);
    if (err.name === 'AbortError') {
      return { ok: true, stopped: true, conversation: convo };
    }
    return { error: 'api-error', message: err.message };
  } finally {
    activeAbortController = null;
  }
});

// Título automático con IA tras el primer intercambio (no bloquea la respuesta).
function maybeGenerateTitle(conversationId, config, messages) {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return;
  const text = typeof firstUser.content === 'string'
    ? firstUser.content
    : (firstUser.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  if (!text.trim()) return;

  sendMessage({
    provider: config.provider || 'anthropic',
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    messages: [{
      role: 'user',
      content: 'Conversación que empieza así:\n\n' + text.slice(0, 600) + '\n\nGenera un título corto.',
    }],
    systemPrompt: 'Respondes SOLO con un título de 4 a 8 palabras para la conversación. Sin comillas, sin formato, sin punto final, sin nada más que el título.',
    maxTokens: 40,
    temperature: 0.7,
  }).then((reply) => {
    const title = (reply.content || '')
      .split('\n')[0]
      .replace(/^[\s"'“”«»]+|[\s"'“”«».]+$/g, '')
      .trim()
      .slice(0, 60);
    if (!title) return;
    store.renameConversation(conversationId, title);
    sendToRenderer('conversations:changed', { id: conversationId, title });
  }).catch(() => { /* sin conexión se queda el título por defecto */ });
}

// ---- Exportar una conversación a Markdown ----
ipcMain.handle('messages:delete', (_evt, conversationId, index) => {
  const convo = store.loadConversation(conversationId);
  if (!convo) return { error: 'not-found' };
  if (typeof index !== 'number' || index < 0 || index >= convo.messages.length) return { error: 'bad-index' };
  convo.messages.splice(index, 1);
  store.saveConversation(convo);
  return { ok: true, conversation: convo };
});

// Genera una imagen con IA (Pollinations.ai — gratuito, sin clave) y devuelve base64.
ipcMain.handle('image:generate', async (_evt, prompt) => {
  const text = String(prompt || '').trim();
  if (!text) return { error: 'empty' };
  try {
    const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(text) +
      '?width=1024&height=1024&nologo=true&model=flux';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { error: 'http', status: res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = (res.headers.get('content-type') || '').split(';')[0];
    if (!ct.startsWith('image/')) return { error: 'not-image', contentType: ct };
    if (buf.length > 10 * 1024 * 1024) return { error: 'too-big' };
    return { ok: true, mediaType: ct, base64: buf.toString('base64'), sizeBytes: buf.length };
  } catch (e) {
    return { error: 'fetch', message: String((e && e.message) || e) };
  }
});

// Agrega un mensaje guardado (p. ej. imagen generada) a una conversación.
ipcMain.handle('messages:add', (_evt, conversationId, role, content) => {
  const convo = store.loadConversation(conversationId);
  if (!convo) return { error: 'not-found' };
  if (role !== 'user' && role !== 'assistant') return { error: 'bad-role' };
  if (!content || (typeof content !== 'string' && !Array.isArray(content))) return { error: 'bad-content' };
  convo.messages.push({ role, content });
  store.saveConversation(convo);
  return { ok: true, conversation: convo };
});

function conversationToMarkdown(convo) {
  const lines = [`# ${convo.title || 'Conversación'}`, '', `_Exportado el ${new Date().toLocaleString()}_`, ''];
  for (const m of convo.messages || []) {
    if (m.role === 'user') lines.push('## 👤 Usuario', '');
    else if (m.role === 'assistant') lines.push('## 🤖 Asistente', '');
    else continue;

    if (m.thinking) {
      lines.push('> **Pensamiento:**', '>');
      lines.push(String(m.thinking).split('\n').map((l) => '> ' + l).join('\n'), '');
    }
    if (typeof m.content === 'string') {
      if (m.content.trim()) lines.push(m.content, '');
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text') lines.push(b.text, '');
        else if (b.type === 'image') lines.push(`🖼 _Imagen: ${b.fileName || 'imagen'}_`, '');
        else if (b.type === 'document') lines.push(`📄 _Documento: ${b.fileName || 'documento'}_`, '');
      }
    }
    if (m.usage) lines.push(`_Tokens: ↑ ${m.usage.input || 0} · ↓ ${m.usage.output || 0}_`, '');
    lines.push('---', '');
  }
  return lines.join('\n');
}

ipcMain.handle('conversations:export', async (_evt, id) => {
  const convo = store.loadConversation(id);
  if (!convo) return { ok: false, error: 'not-found' };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportar conversación',
    defaultPath: `${String(convo.title || 'conversacion').replace(/[\\/:*?"<>|]/g, '-')}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(result.filePath, conversationToMarkdown(convo), 'utf-8');
  return { ok: true, path: result.filePath };
});

// ---- Exportar / importar datos (respaldo) ----
ipcMain.handle('data:export', async () => {
  const json = store.exportUserData();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportar datos de Vortex Chat',
    defaultPath: `vortex-chat-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'Respaldo JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(result.filePath, json, 'utf-8');
  return { ok: true, path: result.filePath };
});

ipcMain.handle('data:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Importar datos de Vortex Chat',
    properties: ['openFile'],
    filters: [{ name: 'Respaldo JSON', extensions: ['json'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  try {
    const json = fs.readFileSync(result.filePaths[0], 'utf-8');
    const summary = store.importUserData(json);
    return { ok: true, importedUsers: summary.importedUsers };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- Detener la generación en curso ----
ipcMain.handle('chat:cancel', () => {
  if (activeAbortController) {
    activeAbortController.abort();
    return true;
  }
  return false;
});
