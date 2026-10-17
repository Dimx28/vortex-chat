// Ejemplo de plugin: añade el número de palabras al final de cada respuesta.
// Un plugin exporta activate(api) y puede registrar hooks:
//   api.registerHook('beforeSend', (texto, ctx) => ...)   // transforma lo que escribe el usuario
//   api.registerHook('afterReceive', (texto, ctx) => ...) // transforma la respuesta del modelo
// Si el hook devuelve un string, ese es el texto que se usa.
exports.activate = (api) => {
  api.registerHook('afterReceive', (texto) => {
    if (typeof texto !== 'string' || !texto.trim()) return texto;
    const n = texto.trim().split(/\s+/).length;
    return `${texto}\n\n— ${n} palabra(s)`;
  });
};
