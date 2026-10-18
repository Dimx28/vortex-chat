const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Configuración
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  getProviders: () => ipcRenderer.invoke('config:providers'),

  // Usuarios
  listUsers: () => ipcRenderer.invoke('users:list'),
  createUser: (name, password) => ipcRenderer.invoke('users:create', name, password),
  switchUser: (userId, password) => ipcRenderer.invoke('users:switch', userId, password),
  getCurrentUser: () => ipcRenderer.invoke('users:current'),
  setUserPassword: (userId, currentPassword, newPassword) =>
    ipcRenderer.invoke('users:setPassword', userId, currentPassword, newPassword),
  renameUser: (userId, name) => ipcRenderer.invoke('users:rename', userId, name),
  deleteUser: (userId) => ipcRenderer.invoke('users:delete', userId),

  // Búsqueda web (Wikipedia + DuckDuckGo)
  webSearch: (query) => ipcRenderer.invoke('web:search', query),

  // Estadísticas del espacio activo
  getStats: () => ipcRenderer.invoke('stats:summary'),

  // Conversaciones
  listConversations: () => ipcRenderer.invoke('conversations:list'),
  loadConversation: (id) => ipcRenderer.invoke('conversations:load', id),
  createConversation: () => ipcRenderer.invoke('conversations:create'),
  deleteConversation: (id) => ipcRenderer.invoke('conversations:delete', id),
  renameConversation: (id, title) => ipcRenderer.invoke('conversations:rename', id, title),
  setConversationFolder: (id, folderId) => ipcRenderer.invoke('conversations:setFolder', id, folderId),
  listFolders: () => ipcRenderer.invoke('folders:list'),
  createFolder: (name) => ipcRenderer.invoke('folders:create', name),
  renameFolder: (id, name) => ipcRenderer.invoke('folders:rename', id, name),
  deleteFolder: (id) => ipcRenderer.invoke('folders:delete', id),
  exportConversation: (id) => ipcRenderer.invoke('conversations:export', id),
  deleteMessage: (conversationId, index) => ipcRenderer.invoke('messages:delete', conversationId, index),
  addMessage: (conversationId, role, content) => ipcRenderer.invoke('messages:add', conversationId, role, content),
  generateImage: (prompt) => ipcRenderer.invoke('image:generate', prompt),
  onConversationsChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('conversations:changed', handler);
    return () => ipcRenderer.removeListener('conversations:changed', handler);
  },

  // Skills
  listSkills: () => ipcRenderer.invoke('skills:list'),
  getSkill: (id) => ipcRenderer.invoke('skills:get', id),
  createSkill: (data) => ipcRenderer.invoke('skills:create', data),
  updateSkill: (id, partial) => ipcRenderer.invoke('skills:update', id, partial),
  deleteSkill: (id) => ipcRenderer.invoke('skills:delete', id),

  // Agente
  agentRun: (task, systemPrompt) => ipcRenderer.invoke('agent:run', { task, systemPrompt }),
  agentResolve: (decision) => ipcRenderer.invoke('agent:resolve', decision),
  agentCancel: () => ipcRenderer.invoke('agent:cancel'),
  agentWorkspace: () => ipcRenderer.invoke('agent:workspace'),
  agentSetWorkspace: () => ipcRenderer.invoke('agent:setWorkspace'),
  onAgentEvent: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  onAgentApproval: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('agent:approval', handler);
    return () => ipcRenderer.removeListener('agent:approval', handler);
  },

  // Plugins
  pluginsList: () => ipcRenderer.invoke('plugins:list'),
  pluginsToggle: (id, enabled) => ipcRenderer.invoke('plugins:toggle', id, enabled),
  pluginsReload: () => ipcRenderer.invoke('plugins:reload'),

  // Archivos
  pickFile: () => ipcRenderer.invoke('files:pick'),

  // Datos (respaldo)
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),

  // Ventana (titlebar personalizado)
  windowControl: (action) => ipcRenderer.invoke('win:control', action),

  // Actualizaciones
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdateEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('update:event', handler);
    return () => ipcRenderer.removeListener('update:event', handler);
  },

  // Chat
  sendMessage: (payload) => ipcRenderer.invoke('chat:send', payload),
  cancelChat: () => ipcRenderer.invoke('chat:cancel'),
  // Se suscribe a los fragmentos de texto que van llegando en vivo (streaming).
  // Devuelve una función para darse de baja cuando termine el mensaje.
  onChatChunk: (callback) => {
    const listener = (_evt, chunk) => callback(chunk);
    ipcRenderer.on('chat:chunk', listener);
    return () => ipcRenderer.removeListener('chat:chunk', listener);
  },
});
