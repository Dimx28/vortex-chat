# Vortex Chat — App de escritorio para chatear con Claude u otros proveedores IA

App de escritorio hecha con **Electron**. Corre 100% en tu computadora: tus conversaciones,
usuarios, skills y archivos se guardan localmente, y solo se envían al proveedor de IA que
elijas cuando envías un mensaje — nunca a ningún otro servidor.

## Qué incluye

### Chat
- **Elegir proveedor de IA**: Anthropic (Claude, directo), OpenRouter, u "Otro" (cualquier
  servicio compatible con el formato "Chat Completions" de OpenAI: Groq, Together, un
  servidor local tipo LM Studio/Ollama, etc.) — se configura en ⚙ Configuración.
- Chat de texto con streaming: el texto (y el razonamiento, en modo pensamiento profundo)
  va apareciendo en vivo a medida que el modelo lo genera.
- Botón **⏹ Detener** para cortar una respuesta a mitad de camino (se guarda lo que ya se
  generó).
- Subir imágenes (png, jpg, gif, webp) y documentos (PDF, txt, md, csv) — hasta 10 MB por
  archivo. Solo Anthropic procesa PDF adjunto directamente; con otros proveedores se avisa
  y solo se registra el nombre.
- Modo **Pensamiento profundo** (razonamiento extendido) con casilla junto al mensaje.
- Historial de conversaciones guardado en tu computadora (renombrar ✏️ y borrar).

### Usuarios
- Varios usuarios/perfiles locales, cada uno con su propio historial, skills y contraseña
  opcional (se gestiona con el botón 🔒). Las contraseñas se guardan con hash `scrypt`,
  nunca en texto plano.

### Skills 🧩
- Plantillas de instrucciones reutilizables. Al elegir un skill en el selector del chat, su
  texto se envía al modelo como instrucción de sistema (system prompt) para esa
  conversación. Se crean/gestionan con el botón 🧩 Skills. Cada usuario tiene los suyos.

### Agente 🤖
- Tareas de varios pasos con herramientas: leer/escribir archivos, ejecutar comandos en la
  terminal y consultar la web. Trabaja dentro de una **área de trabajo** (carpeta que tú
  eliges). **Cada acción pide tu aprobación** antes de ejecutarse (aprobar / rechazar /
  cancelar).

### Plugins 🔌
- Complementos locales en la carpeta `plugins/`. Cada plugin es una subcarpeta con un
  `plugin.json` (manifiesto) y un `index.js` que exporta `activate(api)`. Pueden registrar
  hooks `beforeSend` (transformar lo que escribes) y `afterReceive` (transformar la
  respuesta). **Se ejecutan con permisos completos en tu equipo: solo activa plugins de
  fuentes de confianza.** Ejemplo incluido: `plugins/contador-palabras`.

### Datos
- **Exportar/importar respaldo** (⚙ Configuración → Datos): guarda tus usuarios,
  conversaciones y skills en un archivo JSON, o importa uno previo. No incluye la clave de
  API. Al importar, si un usuario ya existe se crea con un ID nuevo (no se pisa nada).

## Requisitos

- [Node.js](https://nodejs.org/) instalado (versión 18 o superior) — solo para ejecutarla
  desde código. Si usas el instalador .exe, no hace falta.
- Una clave de API de Anthropic (https://console.anthropic.com/), de OpenRouter
  (https://openrouter.ai), o del proveedor compatible que uses. La API se paga por uso;
  no está incluida en ninguna suscripción de Claude.ai.

## Instalación y uso desde código

1. Abre una terminal dentro de la carpeta del proyecto y ejecuta:
   ```
   npm install
   ```
2. Inicia la app:
   ```
   npm start
   ```
3. La primera vez se abre **Configuración**: elige el proveedor, pega tu clave de API, y
   elige o escribe el modelo (en OpenRouter/Otro el formato suele ser `proveedor/modelo`,
   por ejemplo `anthropic/claude-sonnet-4.5` o `openai/gpt-4o`). Guarda y ya puedes chatear.

## Instalador para Windows (.exe)

Ya está generado el instalador con `electron-builder`:

```
npm run dist
```

Eso crea `dist/Vortex Chat Setup 1.0.0.exe` (instalador NSIS: se puede elegir la carpeta
de instalación y crea acceso directo en el escritorio). También hay `npm run dist:dir`
para generar solo la carpeta descomprimida (sin instalador), más rápida de probar.

## Dónde se guardan tus datos

En la carpeta de datos de la app (gestionada por Electron), dentro de `vortex-data`:
- `config.json` — clave de API, modelo, proveedor y ajustes (en texto plano: no compartas
  este archivo).
- `users/<id>/conversations/*.json` — conversaciones, una por archivo.
- `users/<id>/skills/*.json` — skills del usuario.

Usa **Exportar** en ⚙ Configuración → Datos para hacer copias de seguridad fácilmente.

## Sobre las contraseñas de usuario

- Son **opcionales**. Al crear un usuario (botón **+**) puedes dejar la contraseña vacía.
- El botón **🔒** pone/cambia/quita la contraseña del usuario abierto.
- Se guardan con hash `scrypt` (nunca en texto plano).
- **Importante:** protege de alguien que simplemente use la app en tu computadora. No es
  cifrado de disco — alguien con acceso técnico avanzado a los archivos podría llegar al
  historial directamente.

## Estructura del proyecto

```
vortex-chat/
├── main.js                     # Proceso principal (ventana, IPC, backend)
├── preload.js                  # Puente seguro entre la interfaz y el backend
├── package.json                # + configuración de build (electron-builder)
├── plugins/                    # Plugins locales (ej: contador-palabras/)
└── src/
    ├── lib/
    │   ├── store.js            # Usuarios, conversaciones, skills, config, export/import
    │   ├── apiClient.js        # Llamadas a la API (Anthropic + compatibles OpenAI, con streaming)
    │   ├── markdownLite.js     # Renderizado de markdown compartido
    │   ├── agent.js            # Bucle del agente (pasos + herramientas)
    │   ├── agentTools.js       # Herramientas del agente (archivos, terminal, web)
    │   └── pluginHost.js       # Carga y hooks de plugins locales
    └── renderer/
        ├── index.html          # Interfaz
        ├── style.css
        └── renderer.js         # Lógica de la interfaz
```

## Qué se probó

- Sintaxis de todos los archivos JavaScript (`node --check` en todos).
- Pruebas de lógica con Node: skills (CRUD, persistencia del skill activo en la
  conversación, export/import incluye skills y no incluye la clave de API), plugins (carga,
  hooks, habilitar/deshabilitar).
- La app abre sin errores de consola (verificado lanzando Electron).
- Empaquetado: `npm run dist` genera el instalador NSIS sin errores.
