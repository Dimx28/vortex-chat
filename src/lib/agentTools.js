// Herramientas del agente: archivos (dentro de un área de trabajo), terminal y web.
// Cada herramienta se ejecuta SOLO tras aprobación del usuario (pasada desde main.js).
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const MAX_OUTPUT = 12000; // tope de texto devuelto al modelo por herramienta

// Definiciones en formato neutro; apiClient las adapta a Anthropic u OpenAI.
const definitions = [
  {
    name: 'list_dir',
    description: 'Lista los archivos y carpetas de una ruta dentro del área de trabajo.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta relativa al área de trabajo. Vacío = raíz.' } },
      required: [],
    },
  },
  {
    name: 'read_file',
    description: 'Lee el contenido de un archivo de texto dentro del área de trabajo.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta relativa al área de trabajo.' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Crea o sobrescribe un archivo de texto dentro del área de trabajo.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al área de trabajo.' },
        content: { type: 'string', description: 'Contenido completo a escribir.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: 'Ejecuta un comando en la terminal dentro del área de trabajo. Útil para git, npm, pruebas, etc. Peligroso: revísalo bien.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Comando a ejecutar (ej: "npm test").' } },
      required: ['command'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Descarga el texto de una URL (http/https) y lo devuelve recortado.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL completa a descargar.' } },
      required: ['url'],
    },
  },
];

function truncate(text) {
  const s = String(text == null ? '' : text);
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…[recortado, ${s.length} caracteres en total]` : s;
}

// Evita escapar del área de trabajo: resuelve y comprueba el prefijo.
function safeResolve(workspace, relPath) {
  const root = path.resolve(workspace);
  const target = path.resolve(root, relPath || '.');
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('La ruta está fuera del área de trabajo.');
  }
  return target;
}

async function execute(name, input, workspace) {
  try {
    switch (name) {
      case 'list_dir': {
        const dir = safeResolve(workspace, input.path || '.');
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .map((e) => (e.isDirectory() ? e.name + '/' : e.name));
        return { ok: true, output: truncate(entries.join('\n') || '(carpeta vacía)') };
      }
      case 'read_file': {
        const file = safeResolve(workspace, input.path);
        const stat = fs.statSync(file);
        if (stat.size > 2 * 1024 * 1024) return { ok: false, error: 'El archivo pesa más de 2 MB; no se lee completo.' };
        return { ok: true, output: truncate(fs.readFileSync(file, 'utf-8')) };
      }
      case 'write_file': {
        const file = safeResolve(workspace, input.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(input.content ?? ''), 'utf-8');
        return { ok: true, output: `Escrito ${path.relative(path.resolve(workspace), file)} (${String(input.content ?? '').length} caracteres).` };
      }
      case 'run_command': {
        const cmd = String(input.command || '').trim();
        if (!cmd) return { ok: false, error: 'Comando vacío.' };
        const output = await new Promise((resolve, reject) => {
          exec(cmd, { cwd: workspace, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            if (err && !stdout && !stderr) return reject(err);
            resolve([stdout, stderr, err ? `\n(código de salida: ${err.code ?? 'n/a'})` : ''].filter(Boolean).join('\n'));
          });
        });
        return { ok: true, output: truncate(output || '(sin salida)') };
      }
      case 'web_fetch': {
        const url = String(input.url || '');
        if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Solo se permiten URLs http/https.' };
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const text = await res.text();
        return { ok: true, output: truncate(text) };
      }
      default:
        return { ok: false, error: `Herramienta desconocida: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = { definitions, execute };
