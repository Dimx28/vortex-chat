// Hospedador de plugins locales: cada plugin es una carpeta dentro de "plugins/"
// con un plugin.json (manifiesto) y un index.js que exporta activate(api).
// IMPORTANTE: los plugins se ejecutan en el proceso principal con privilegios
// completos de Node. Solo activa plugins de fuentes de confianza.
const fs = require('fs');
const path = require('path');

let pluginsDir = null;
let loaded = []; // { id, name, hooks: { beforeSend: [], afterReceive: [] } }

function init(appDir) {
  pluginsDir = path.join(appDir, 'plugins');
  try { fs.mkdirSync(pluginsDir, { recursive: true }); } catch { /* se ignora */ }
}

function listPlugins() {
  if (!pluginsDir || !fs.existsSync(pluginsDir)) return [];
  return fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(pluginsDir, d.name);
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8')); } catch { /* sin manifiesto */ }
      if (!manifest) return null;
      return {
        id: d.name,
        dir,
        name: manifest.name || d.name,
        description: manifest.description || '',
        version: manifest.version || '',
        main: manifest.main || 'index.js',
      };
    })
    .filter(Boolean);
}

function loadEnabled(enabledMap) {
  loaded = [];
  for (const p of listPlugins()) {
    if (!enabledMap || !enabledMap[p.id]) continue;
    try {
      const modPath = path.join(p.dir, p.main);
      delete require.cache[require.resolve(modPath)];
      const mod = require(modPath);
      const hooks = { beforeSend: [], afterReceive: [] };
      if (mod && typeof mod.activate === 'function') {
        const api = {
          log: (...args) => console.log(`[plugin ${p.name}]`, ...args),
          registerHook: (hook, fn) => { if (hooks[hook] && typeof fn === 'function') hooks[hook].push(fn); },
          getDataDir: () => {
            const d = path.join(p.dir, 'data');
            fs.mkdirSync(d, { recursive: true });
            return d;
          },
        };
        mod.activate(api);
      }
      loaded.push({ id: p.id, name: p.name, hooks });
    } catch (e) {
      console.error(`[plugin ${p.name}] error al cargar:`, e.message);
      loaded.push({ id: p.id, name: p.name, error: e.message, hooks: { beforeSend: [], afterReceive: [] } });
    }
  }
}

// Ejecuta los hooks en cadena. Si un hook devuelve un valor (no undefined),
// ese valor pasa al siguiente hook como entrada.
async function runHookAsync(hook, initial, context) {
  let value = initial;
  for (const p of loaded) {
    if (p.error) continue;
    for (const fn of p.hooks[hook] || []) {
      try {
        const out = await fn(value, context);
        if (out !== undefined) value = out;
      } catch (e) {
        console.error(`[plugin ${p.name}] ${hook} error:`, e.message);
      }
    }
  }
  return value;
}

module.exports = { init, listPlugins, loadEnabled, runHookAsync };
