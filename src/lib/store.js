const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let BASE_DIR, USERS_DIR, CONFIG_FILE, CURRENT_USER_FILE;

function init(userDataPath) {
  BASE_DIR = path.join(userDataPath, 'vortex-data');
  USERS_DIR = path.join(BASE_DIR, 'users');
  CONFIG_FILE = path.join(BASE_DIR, 'config.json');
  CURRENT_USER_FILE = path.join(BASE_DIR, 'current-user.json');

  // Migración: la primera versión guardaba todo en "chat-libre-data".
  const legacyDir = path.join(userDataPath, 'chat-libre-data');
  if (!fs.existsSync(BASE_DIR) && fs.existsSync(legacyDir)) {
    try {
      fs.renameSync(legacyDir, BASE_DIR);
    } catch {
      // Si falla el renombrado (p. ej. carpeta en uso), se copia y se deja la original.
      fs.mkdirSync(BASE_DIR, { recursive: true });
      fs.cpSync(legacyDir, BASE_DIR, { recursive: true });
    }
  }

  fs.mkdirSync(USERS_DIR, { recursive: true });

  if (!fs.existsSync(CONFIG_FILE)) {
    writeJSON(CONFIG_FILE, { provider: 'anthropic', apiKey: '', model: 'claude-sonnet-5', baseUrl: '' });
  }

  // Si no hay ningún usuario, crea uno por defecto
  if (listUsers().length === 0) {
    createUser('Yo');
  }
  if (!fs.existsSync(CURRENT_USER_FILE)) {
    const users = listUsers();
    switchUserUnsafe(users[0].id);
  }
}

// ---------- Contraseñas (hash con scrypt, nunca se guarda en texto plano) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPasswordHash(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  // Comparación en tiempo constante para evitar filtrar información por timing
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ---------- Configuración ----------
function getConfig() {
  return readJSON(CONFIG_FILE, { provider: 'anthropic', apiKey: '', model: 'claude-sonnet-5', baseUrl: '' });
}
function setConfig(partial) {
  const current = getConfig();
  const updated = { ...current, ...partial };
  writeJSON(CONFIG_FILE, updated);
  return updated;
}

// ---------- Usuarios ----------
function userDir(userId) {
  return path.join(USERS_DIR, userId);
}
function readFullProfile(id) {
  return readJSON(path.join(userDir(id), 'profile.json'), { id, name: id });
}
// Versión pública: nunca expone salt/hash al renderer, solo si tiene contraseña o no.
function toPublicProfile(profile) {
  const { passwordSalt, passwordHash, ...pub } = profile;
  return { ...pub, hasPassword: Boolean(passwordHash) };
}
function listUsers() {
  if (!fs.existsSync(USERS_DIR)) return [];
  return fs.readdirSync(USERS_DIR)
    .filter((f) => fs.statSync(path.join(USERS_DIR, f)).isDirectory())
    .map((id) => toPublicProfile(readFullProfile(id)));
}
function createUser(name, password) {
  const id = crypto.randomUUID();
  const dir = userDir(id);
  fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
  const profile = { id, name: name || 'Usuario', createdAt: Date.now() };
  if (password) {
    const { salt, hash } = hashPassword(password);
    profile.passwordSalt = salt;
    profile.passwordHash = hash;
  }
  writeJSON(path.join(dir, 'profile.json'), profile);
  writeJSON(CURRENT_USER_FILE, { userId: id });
  return toPublicProfile(profile);
}
function getCurrentUser() {
  const { userId } = readJSON(CURRENT_USER_FILE, {});
  const users = listUsers();
  return users.find((u) => u.id === userId) || users[0];
}
// Cambia de usuario SIN pedir contraseña (uso interno, ej. al inicializar).
function switchUserUnsafe(userId) {
  writeJSON(CURRENT_USER_FILE, { userId });
  return getCurrentUser();
}
// Cambia de usuario verificando la contraseña si ese usuario tiene una configurada.
// Devuelve { ok: true, user } o { ok: false, error: 'wrong-password' | 'not-found' }.
function switchUser(userId, password) {
  const profile = readFullProfile(userId);
  if (!profile || !profile.id) return { ok: false, error: 'not-found' };
  if (profile.passwordHash) {
    if (!password || !verifyPasswordHash(password, profile.passwordSalt, profile.passwordHash)) {
      return { ok: false, error: 'wrong-password' };
    }
  }
  writeJSON(CURRENT_USER_FILE, { userId });
  return { ok: true, user: toPublicProfile(profile) };
}
// Cambia la contraseña de un usuario. Si ya tenía una, exige la actual para confirmarla.
// newPassword vacío/null quita la contraseña (usuario vuelve a quedar sin clave).
function setUserPassword(userId, currentPassword, newPassword) {
  const profile = readFullProfile(userId);
  if (!profile || !profile.id) return { ok: false, error: 'not-found' };
  if (profile.passwordHash) {
    if (!currentPassword || !verifyPasswordHash(currentPassword, profile.passwordSalt, profile.passwordHash)) {
      return { ok: false, error: 'wrong-password' };
    }
  }
  if (newPassword) {
    const { salt, hash } = hashPassword(newPassword);
    profile.passwordSalt = salt;
    profile.passwordHash = hash;
  } else {
    delete profile.passwordSalt;
    delete profile.passwordHash;
  }
  writeJSON(path.join(userDir(userId), 'profile.json'), profile);
  return { ok: true, user: toPublicProfile(profile) };
}

// ---------- Conversaciones (por usuario actual) ----------
function convosDir() {
  const user = getCurrentUser();
  return path.join(userDir(user.id), 'conversations');
}
function listConversations() {
  const dir = convosDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const c = readJSON(path.join(dir, f), null);
      return c && { id: c.id, title: c.title, updatedAt: c.updatedAt, folderId: c.folderId || null };
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
function loadConversation(id) {
  const file = path.join(convosDir(), `${id}.json`);
  return readJSON(file, null);
}
function createConversation() {
  const id = crypto.randomUUID();
  const convo = { id, title: 'Nueva conversación', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  saveConversation(convo);
  return convo;
}
function saveConversation(convo) {
  convo.updatedAt = Date.now();
  if ((!convo.title || convo.title === 'Nueva conversación') && convo.messages.length > 0) {
    const firstUserMsg = convo.messages.find((m) => m.role === 'user');
    if (firstUserMsg) {
      const text = extractPlainText(firstUserMsg.content).slice(0, 48);
      if (text) convo.title = text;
    }
  }
  writeJSON(path.join(convosDir(), `${convo.id}.json`), convo);
}
function deleteConversation(id) {
  const file = path.join(convosDir(), `${id}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return true;
}
function renameConversation(id, title) {
  const convo = loadConversation(id);
  if (!convo) return null;
  convo.title = title;
  saveConversation(convo);
  return convo;
}

// ---------- Carpetas (por usuario, agrupan conversaciones en la barra lateral) ----------
function foldersFile() {
  return path.join(userDir(getCurrentUser().id), 'folders.json');
}
function listFolders() {
  return readJSON(foldersFile(), []);
}
function createFolder(name) {
  const folder = {
    id: crypto.randomUUID(),
    name: String(name || 'Nueva carpeta').trim().slice(0, 60) || 'Nueva carpeta',
    createdAt: Date.now(),
  };
  const all = listFolders();
  all.push(folder);
  writeJSON(foldersFile(), all);
  return folder;
}
function renameFolder(id, name) {
  const all = listFolders();
  const f = all.find((x) => x.id === id);
  if (!f) return null;
  f.name = String(name || '').trim().slice(0, 60) || f.name;
  writeJSON(foldersFile(), all);
  return f;
}
function deleteFolder(id) {
  const all = listFolders();
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return false;
  writeJSON(foldersFile(), next);
  // Quita la carpeta de las conversaciones que la usaban (sin tocar updatedAt).
  const dir = convosDir();
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).filter((f) => f.endsWith('.json')).forEach((f) => {
      const file = path.join(dir, f);
      const c = readJSON(file, null);
      if (c && c.folderId === id) {
        delete c.folderId;
        writeJSON(file, c);
      }
    });
  }
  return true;
}
// Mueve una conversación a una carpeta (o a "sin carpeta" con null).
// Escribe directo para no alterar updatedAt ni reordenar la lista.
function setConversationFolder(convoId, folderId) {
  const file = path.join(convosDir(), `${convoId}.json`);
  const convo = readJSON(file, null);
  if (!convo) return null;
  if (folderId) convo.folderId = folderId;
  else delete convo.folderId;
  writeJSON(file, convo);
  return convo;
}

function extractPlainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // El mensaje del usuario siempre termina con su texto real (ver buildUserMessage),
    // así que se toma el último bloque de texto, no el primero (que podría ser un adjunto).
    const textBlocks = content.filter((b) => b.type === 'text');
    const lastBlock = textBlocks[textBlocks.length - 1];
    return lastBlock ? lastBlock.text : '';
  }
  return '';
}

// ---------- Skills (plantillas de instrucciones, por usuario) ----------
function skillsDir(userId) {
  const id = userId || (getCurrentUser() || {}).id;
  return path.join(userDir(id), 'skills');
}
function listSkills(userId) {
  const dir = skillsDir(userId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJSON(path.join(dir, f), null))
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function getSkill(id, userId) {
  const file = path.join(skillsDir(userId), `${id}.json`);
  return readJSON(file, null);
}
function createSkill({ name, description, content }, userId) {
  const id = crypto.randomUUID();
  const skill = {
    id,
    name: name || 'Skill sin nombre',
    description: description || '',
    content: content || '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  fs.mkdirSync(skillsDir(userId), { recursive: true });
  writeJSON(path.join(skillsDir(userId), `${id}.json`), skill);
  return skill;
}
function updateSkill(id, partial, userId) {
  const skill = getSkill(id, userId);
  if (!skill) return null;
  const updated = { ...skill, ...partial, id, updatedAt: Date.now() };
  writeJSON(path.join(skillsDir(userId), `${id}.json`), updated);
  return updated;
}
function deleteSkill(id, userId) {
  const file = path.join(skillsDir(userId), `${id}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return true;
}

function buildUserMessage(userText, attachments) {
  const blocks = [];
  for (const att of attachments || []) {
    if (att.kind === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.base64 }, fileName: att.fileName });
    } else if (att.kind === 'document') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: att.mediaType, data: att.base64 }, fileName: att.fileName });
    } else {
      // Texto plano (txt, md, csv): se adjunta como texto citado
      const decoded = Buffer.from(att.base64, 'base64').toString('utf-8');
      blocks.push({ type: 'text', text: `[Archivo adjunto: ${att.fileName}]\n${decoded}` });
    }
  }
  // Solo se añade el bloque con el texto del usuario si escribió algo:
  // algunos proveedores (Anthropic) rechazan bloques de texto vacíos.
  if (userText && userText.trim()) {
    blocks.push({ type: 'text', text: userText });
  }
  return { role: 'user', content: blocks };
}

function exportUserData() {
  const users = fs.readdirSync(USERS_DIR)
    .filter((f) => fs.statSync(path.join(USERS_DIR, f)).isDirectory())
    .map((id) => {
      const profilePath = path.join(USERS_DIR, id, 'profile.json');
      const profile = readJSON(profilePath, { id });
      const convDir = path.join(USERS_DIR, id, 'conversations');
      const conversations = [];
      if (fs.existsSync(convDir)) {
        fs.readdirSync(convDir).filter((f) => f.endsWith('.json')).forEach((f) => {
          const c = readJSON(path.join(convDir, f), null);
          if (c) conversations.push(c);
        });
      }
      const skDir = path.join(USERS_DIR, id, 'skills');
      const skills = [];
      if (fs.existsSync(skDir)) {
        fs.readdirSync(skDir).filter((f) => f.endsWith('.json')).forEach((f) => {
          const s = readJSON(path.join(skDir, f), null);
          if (s) skills.push(s);
        });
      }
      const folders = readJSON(path.join(USERS_DIR, id, 'folders.json'), []);
      return { profile, conversations, skills, folders };
    });
  const config = readJSON(CONFIG_FILE, { provider: 'anthropic', apiKey: '', model: 'claude-sonnet-5', baseUrl: '' });
  const { apiKey, ...safeConfig } = config;
  return JSON.stringify({
    version: 1,
    exportedAt: Date.now(),
    config: safeConfig,
    users,
  }, null, 2);
}

function importUserData(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new Error('El archivo de exportación no es válido');
  }
  if (!data || typeof data !== 'object') throw new Error('Formato de exportación inválido');
  const users = Array.isArray(data.users) ? data.users : [];
  users.forEach((entry) => {
    if (!entry || !entry.profile) return;
    const srcId = entry.profile.id;
    let newId = srcId;
    let dir = userDir(newId);
    while (fs.existsSync(dir)) {
      newId = crypto.randomUUID();
      dir = userDir(newId);
    }
    fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
    const profile = { ...entry.profile, id: newId };
    delete profile.passwordSalt;
    delete profile.passwordHash;
    if (entry.profile.passwordSalt && entry.profile.passwordHash) {
      profile.passwordSalt = entry.profile.passwordSalt;
      profile.passwordHash = entry.profile.passwordHash;
    }
    writeJSON(path.join(dir, 'profile.json'), profile);
    const convDir = path.join(dir, 'conversations');
    // Carpetas primero: se les da ID nuevo y se mapea el viejo para reasignar convos.
    const folderIdMap = {};
    const folders = Array.isArray(entry.folders) ? entry.folders : [];
    if (folders.length) {
      const newFolders = folders.filter((f) => f && f.id).map((f) => {
        const newFid = crypto.randomUUID();
        folderIdMap[f.id] = newFid;
        return { ...f, id: newFid, createdAt: f.createdAt || Date.now() };
      });
      writeJSON(path.join(dir, 'folders.json'), newFolders);
    }
    (entry.conversations || []).forEach((c) => {
      if (!c || !c.id) return;
      const newConvId = crypto.randomUUID();
      const conv = { ...c, id: newConvId, updatedAt: c.updatedAt || Date.now(), createdAt: c.createdAt || Date.now() };
      if (conv.folderId) {
        if (folderIdMap[conv.folderId]) conv.folderId = folderIdMap[conv.folderId];
        else delete conv.folderId;
      }
      writeJSON(path.join(convDir, `${newConvId}.json`), conv);
    });
    const skDir = path.join(dir, 'skills');
    fs.mkdirSync(skDir, { recursive: true });
    (entry.skills || []).forEach((s) => {
      if (!s || !s.name) return;
      const newSkillId = crypto.randomUUID();
      const skill = { ...s, id: newSkillId, updatedAt: s.updatedAt || Date.now(), createdAt: s.createdAt || Date.now() };
      writeJSON(path.join(skDir, `${newSkillId}.json`), skill);
    });
  });
  return { importedUsers: users.length };
}

// Renombra un espacio/usuario.
function renameUser(userId, name) {
  const profile = readFullProfile(userId);
  if (!profile || !profile.id) return null;
  profile.name = String(name || '').trim().slice(0, 40) || profile.name;
  writeJSON(path.join(userDir(userId), 'profile.json'), profile);
  return toPublicProfile(profile);
}

// Elimina un espacio/usuario por completo (su carpeta con datos).
// No permite borrar el espacio activo: hay que cambiar a otro primero.
function deleteUser(userId) {
  const current = getCurrentUser();
  if (current && current.id === userId) return { ok: false, error: 'is-current' };
  const dir = userDir(userId);
  if (!fs.existsSync(dir)) return { ok: false, error: 'not-found' };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

// Estadísticas agregadas del espacio de trabajo activo (para la vista Historial).
function getStats() {
  const user = getCurrentUser();
  const dir = path.join(userDir(user.id), 'conversations');
  let conversations = 0, messages = 0, tokensInput = 0, tokensOutput = 0, attachments = 0;
  let firstActivity = null, lastActivity = null;
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).filter((f) => f.endsWith('.json')).forEach((f) => {
      const c = readJSON(path.join(dir, f), null);
      if (!c) return;
      conversations++;
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      messages += msgs.length;
      for (const m of msgs) {
        if (m.role === 'user' && Array.isArray(m.content)) {
          attachments += m.content.filter((b) => b && (b.type === 'image' || b.type === 'document')).length;
        }
        if (m.usage) {
          tokensInput += m.usage.input || 0;
          tokensOutput += m.usage.output || 0;
        }
      }
      const created = c.createdAt || c.updatedAt || null;
      if (created && (!firstActivity || created < firstActivity)) firstActivity = created;
      if (c.updatedAt && (!lastActivity || c.updatedAt > lastActivity)) lastActivity = c.updatedAt;
    });
  }
  return {
    conversations,
    messages,
    tokensInput,
    tokensOutput,
    attachments,
    skills: listSkills(user.id).length,
    folders: listFolders().length,
    spaces: listUsers().length,
    firstActivity,
    lastActivity,
  };
}

module.exports = {
  init, getConfig, setConfig,
  listUsers, createUser, getCurrentUser, switchUser, setUserPassword, renameUser, deleteUser, getStats,
  listConversations, loadConversation, createConversation,
  saveConversation, deleteConversation, renameConversation,
  listSkills, getSkill, createSkill, updateSkill, deleteSkill,
  listFolders, createFolder, renameFolder, deleteFolder, setConversationFolder,
  buildUserMessage,
  exportUserData, importUserData,
};
