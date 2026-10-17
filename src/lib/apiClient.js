// Proveedores soportados. "anthropic" usa la API nativa de Claude (Messages API).
// "openrouter" y "custom" usan el formato compatible con OpenAI (Chat Completions),
// que es el que habla OpenRouter y la mayoría de los servicios alternativos (Groq,
// Together, servidores locales tipo LM Studio/Ollama con endpoint compatible, etc).
const PROVIDER_PRESETS = {
  anthropic: { baseUrl: 'https://api.anthropic.com/v1/messages', label: 'Anthropic (Claude)' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1/chat/completions', label: 'OpenRouter' },
  custom: { baseUrl: '', label: 'Otro (compatible con OpenAI)' },
};

function resolveBaseUrl(provider, customBaseUrl) {
  if (provider === 'custom') return customBaseUrl || '';
  return PROVIDER_PRESETS[provider]?.baseUrl || PROVIDER_PRESETS.anthropic.baseUrl;
}

// ---------- Anthropic (Messages API) ----------
function cleanAnthropicBlock(block) {
  const { fileName, ...rest } = block;
  return rest;
}
function toAnthropicMessages(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map(cleanAnthropicBlock),
  }));
}

async function sendToAnthropic({ apiKey, baseUrl, model, messages, thinkingMode, signal, systemPrompt, temperature, maxTokens }) {
  const body = {
    model: model || 'claude-sonnet-5',
    max_tokens: maxTokens || (thinkingMode ? 4096 : 2048),
    messages: toAnthropicMessages(messages),
  };
  if (systemPrompt) body.system = systemPrompt;
  if (thinkingMode) body.thinking = { type: 'enabled', budget_tokens: 2000 };
  if (temperature != null && temperature !== '' && !thinkingMode) body.temperature = Number(temperature);

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw new Error(await describeError(res));

  const data = await res.json();
  const textBlocks = data.content.filter((b) => b.type === 'text').map((b) => b.text);
  const thinkingBlocks = data.content.filter((b) => b.type === 'thinking').map((b) => b.thinking);
  const usage = data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens } : null;
  return {
    content: textBlocks.join('\n\n') || '(sin respuesta de texto)',
    thinking: thinkingBlocks.join('\n\n') || null,
    usage,
  };
}

// ---------- Compatible con OpenAI (OpenRouter, Groq, Together, local, etc.) ----------
function toOpenAIContentBlock(block, warnings) {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') {
    return { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
  }
  if (block.type === 'document') {
    // No todos los modelos/proveedores aceptan PDF en binario por este formato;
    // se avisa en vez de enviar datos que el modelo no podría interpretar.
    warnings.add('pdf');
    return { type: 'text', text: `[Documento adjunto "${block.fileName || 'archivo.pdf'}" — este proveedor no admite PDF adjunto directamente, solo el nombre quedó registrado.]` };
  }
  return { type: 'text', text: '' };
}
function toOpenAIMessages(messages, warnings) {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map((b) => toOpenAIContentBlock(b, warnings)),
  }));
}

async function sendToOpenAICompatible({ apiKey, baseUrl, model, messages, thinkingMode, signal, systemPrompt, temperature, maxTokens }) {
  if (!baseUrl) throw new Error('Falta la URL base del proveedor "Otro" en Configuración.');
  const warnings = new Set();
  let outMessages = toOpenAIMessages(messages, warnings);
  if (systemPrompt) outMessages = [{ role: 'system', content: systemPrompt }].concat(outMessages);
  const body = {
    model: model || 'auto',
    messages: outMessages,
    max_tokens: maxTokens || (thinkingMode ? 4096 : 2048),
  };
  // Parámetro unificado de razonamiento que usa OpenRouter para modelos que lo soportan.
  // En proveedores que no lo reconocen, normalmente se ignora sin romper la petición.
  if (thinkingMode) body.reasoning = { enabled: true };
  if (temperature != null && temperature !== '' && !thinkingMode) body.temperature = Number(temperature);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  // Cabeceras recomendadas por OpenRouter (opcionales, ayudan a identificar la app)
  if (baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://vortex-chat.local';
    headers['X-Title'] = 'Vortex Chat';
  }

  const res = await fetch(baseUrl, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(await describeError(res));

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('El proveedor respondió sin contenido (choices vacío).');

  const content = choice.message?.content || '(sin respuesta de texto)';
  const reasoning = choice.message?.reasoning || null;
  const usage = data.usage
    ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
    : null;
  const pdfWarning = warnings.has('pdf') ? '\n\n⚠ Nota: este proveedor no procesa PDF adjunto directamente.' : '';
  return { content: content + (pdfWarning && !content.includes('no admite PDF') ? pdfWarning : ''), thinking: reasoning, usage };
}

async function describeError(res) {
  const errText = await res.text();
  try {
    const parsed = JSON.parse(errText);
    return `${res.status}: ${parsed.error?.message || errText}`;
  } catch {
    return `${res.status}: ${errText}`;
  }
}

function usageObj(input, output) {
  if (input == null && output == null) return null;
  const inT = input || 0;
  const outT = output || 0;
  return { input: inT, output: outT, total: inT + outT };
}

// ---------- Lector genérico de eventos SSE (Server-Sent Events) ----------
// Llama a onEvent(eventName, dataStr) por cada bloque "event:/data:" que llega.
async function parseSSE(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let eventName = null;
      const dataLines = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) onEvent(eventName, dataLines.join('\n'));
    }
  }
}

// ---------- Anthropic con streaming ----------
async function sendToAnthropicStream({ apiKey, baseUrl, model, messages, thinkingMode, onChunk, signal, systemPrompt, temperature, maxTokens }) {
  const body = {
    model: model || 'claude-sonnet-5',
    max_tokens: maxTokens || (thinkingMode ? 4096 : 2048),
    messages: toAnthropicMessages(messages),
    stream: true,
  };
  if (systemPrompt) body.system = systemPrompt;
  if (thinkingMode) body.thinking = { type: 'enabled', budget_tokens: 2000 };
  if (temperature != null && temperature !== '' && !thinkingMode) body.temperature = Number(temperature);

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(await describeError(res));

  let textAcc = '';
  let thinkingAcc = '';
  let usageIn = null;
  let usageOut = null;
  try {
    await parseSSE(res.body, (_event, dataStr) => {
      let data;
      try { data = JSON.parse(dataStr); } catch { return; }
      if (data.type === 'message_start' && data.message?.usage) {
        usageIn = data.message.usage.input_tokens;
        if (data.message.usage.output_tokens) usageOut = data.message.usage.output_tokens;
      } else if (data.type === 'message_delta' && data.usage) {
        if (data.usage.output_tokens != null) usageOut = data.usage.output_tokens;
        if (data.usage.input_tokens != null) usageIn = data.usage.input_tokens;
      } else if (data.type === 'content_block_delta') {
        if (data.delta?.type === 'text_delta' && data.delta.text) {
          textAcc += data.delta.text;
          onChunk && onChunk({ type: 'text', text: data.delta.text });
        } else if (data.delta?.type === 'thinking_delta' && data.delta.thinking) {
          thinkingAcc += data.delta.thinking;
          onChunk && onChunk({ type: 'thinking', text: data.delta.thinking });
        }
      } else if (data.type === 'error') {
        throw new Error(data.error?.message || 'Error de streaming de Anthropic');
      }
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return { content: textAcc, thinking: thinkingAcc || null, stopped: true, usage: usageObj(usageIn, usageOut) };
    }
    throw err;
  }

  return { content: textAcc || '(sin respuesta de texto)', thinking: thinkingAcc || null, usage: usageObj(usageIn, usageOut) };
}

// ---------- Compatible con OpenAI, con streaming ----------
async function sendToOpenAICompatibleStream({ apiKey, baseUrl, model, messages, thinkingMode, onChunk, signal, systemPrompt, temperature, maxTokens }) {
  if (!baseUrl) throw new Error('Falta la URL base del proveedor "Otro" en Configuración.');
  const warnings = new Set();
  let outMessages = toOpenAIMessages(messages, warnings);
  if (systemPrompt) outMessages = [{ role: 'system', content: systemPrompt }].concat(outMessages);
  const body = {
    model: model || 'auto',
    messages: outMessages,
    max_tokens: maxTokens || (thinkingMode ? 4096 : 2048),
    stream: true,
    // Pide el uso de tokens en el último bloque (lo soportan OpenAI, OpenRouter
    // y la mayoría de servidores compatibles; si no, simplemente no llega).
    stream_options: { include_usage: true },
  };
  if (thinkingMode) body.reasoning = { enabled: true };
  if (temperature != null && temperature !== '' && !thinkingMode) body.temperature = Number(temperature);

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  if (baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://vortex-chat.local';
    headers['X-Title'] = 'Vortex Chat';
  }

  const res = await fetch(baseUrl, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(await describeError(res));

  let textAcc = '';
  let reasoningAcc = '';
  let usage = null;
  try {
    await parseSSE(res.body, (_event, dataStr) => {
      if (dataStr === '[DONE]') return;
      let data;
      try { data = JSON.parse(dataStr); } catch { return; }
      if (data.usage) usage = { input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
      const delta = data.choices && data.choices[0] && data.choices[0].delta;
      if (!delta) return;
      if (delta.content) {
        textAcc += delta.content;
        onChunk && onChunk({ type: 'text', text: delta.content });
      }
      if (delta.reasoning) {
        reasoningAcc += delta.reasoning;
        onChunk && onChunk({ type: 'thinking', text: delta.reasoning });
      }
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return { content: textAcc, thinking: reasoningAcc || null, stopped: true, usage };
    }
    throw err;
  }

  const pdfWarning = warnings.has('pdf') && !textAcc.includes('no admite PDF')
    ? '\n\n⚠ Nota: este proveedor no procesa PDF adjunto directamente.' : '';
  return { content: (textAcc || '(sin respuesta de texto)') + pdfWarning, thinking: reasoningAcc || null, usage };
}

// ---------- Punto de entrada único ----------
// Si se pasa onChunk, se usa la variante con streaming (el texto va llegando en vivo).
// Si no, se usa la variante clásica (espera la respuesta completa).
async function sendMessage({ provider, apiKey, baseUrl, model, messages, thinkingMode, onChunk, signal, systemPrompt, temperature, maxTokens }) {
  const resolvedBaseUrl = resolveBaseUrl(provider, baseUrl);
  const args = { apiKey, baseUrl: resolvedBaseUrl, model, messages, thinkingMode, onChunk, signal, systemPrompt, temperature, maxTokens };

  if (provider === 'anthropic') {
    return onChunk ? sendToAnthropicStream(args) : sendToAnthropic(args);
  }
  return onChunk ? sendToOpenAICompatibleStream(args) : sendToOpenAICompatible(args);
}

// ---------- Agente: llamadas con herramientas (tool use) ----------
// Formato interno de mensajes del agente:
//   { role: 'assistant', content, toolCalls: [{ id, name, input }] }
//   { role: 'tool', results: [{ toolCallId, name, result: { ok, output } }] }

function toAnthropicWithTools(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      // Anthropic exige los tool_result en un único mensaje "user".
      out.push({
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.toolCallId,
          content: JSON.stringify(r.result),
          is_error: !r.result?.ok,
        })),
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input || {} });
      out.push({ role: 'assistant', content });
      continue;
    }
    out.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : (m.content || []).map(cleanAnthropicBlock),
    });
  }
  return out;
}

function toOpenAIWithTools(messages) {
  const warnings = new Set();
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.toolCallId, content: JSON.stringify(r.result) });
      }
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
        })),
      });
      continue;
    }
    out.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : (m.content || []).map((b) => toOpenAIContentBlock(b, warnings)),
    });
  }
  return out;
}

function toToolDefsOpenAI(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

async function sendWithTools({ provider, apiKey, baseUrl, model, messages, systemPrompt, tools, signal, maxTokens }) {
  const resolvedBaseUrl = resolveBaseUrl(provider, baseUrl);
  if (provider === 'anthropic') {
    const body = {
      model: model || 'claude-sonnet-5',
      max_tokens: maxTokens || 4096,
      messages: toAnthropicWithTools(messages),
      tools: tools || [],
    };
    if (systemPrompt) body.system = systemPrompt;
    const res = await fetch(resolvedBaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(await describeError(res));
    const data = await res.json();
    const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
    const thinking = data.content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n\n') || null;
    const toolCalls = data.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
    return { content: text, thinking, toolCalls, assistantMessage: { role: 'assistant', content: text, toolCalls } };
  }

  // Compatible con OpenAI
  if (!resolvedBaseUrl) throw new Error('Falta la URL base del proveedor "Otro" en Configuración.');
  let outMessages = toOpenAIWithTools(messages);
  if (systemPrompt) outMessages = [{ role: 'system', content: systemPrompt }].concat(outMessages);
  const body = {
    model: model || 'auto',
    messages: outMessages,
    max_tokens: maxTokens || 4096,
    tools: toToolDefsOpenAI(tools),
  };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  if (resolvedBaseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://vortex-chat.local';
    headers['X-Title'] = 'Vortex Chat';
  }
  const res = await fetch(resolvedBaseUrl, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(await describeError(res));
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('El proveedor respondió sin contenido (choices vacío).');
  const msg = choice.message || {};
  const toolCalls = (msg.tool_calls || []).map((c) => {
    let input = {};
    try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = {}; }
    return { id: c.id, name: c.function?.name, input };
  });
  return { content: msg.content || '', thinking: msg.reasoning || null, toolCalls, assistantMessage: { role: 'assistant', content: msg.content || '', toolCalls } };
}

module.exports = { sendMessage, sendWithTools, PROVIDER_PRESETS };
