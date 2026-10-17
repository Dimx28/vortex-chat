// Bucle del agente: pide al modelo, ejecuta herramientas aprobadas por el usuario,
// y repite hasta que el modelo responda sin pedir herramientas (o se cancele).
const tools = require('./agentTools');
const { sendWithTools } = require('./apiClient');

const MAX_STEPS = 12;

// onEvent(evt) recibe: { type: 'assistant'|'tool_request'|'tool_result', ... }
// requestApproval(name, input) devuelve true | false | 'cancel'
async function runAgent({ config, messages, systemPrompt, workspace, onEvent, requestApproval, signal }) {
  const convo = messages.slice();

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal && signal.aborted) return { stopped: true, content: '' };

    const reply = await sendWithTools({
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      messages: convo,
      systemPrompt,
      tools: tools.definitions,
      signal,
    });

    convo.push(reply.assistantMessage);
    if (reply.content || reply.thinking) {
      onEvent({ type: 'assistant', content: reply.content, thinking: reply.thinking });
    }

    if (!reply.toolCalls.length) {
      return { content: reply.content, thinking: reply.thinking };
    }

    const results = [];
    for (const tc of reply.toolCalls) {
      onEvent({ type: 'tool_request', id: tc.id, name: tc.name, input: tc.input });
      const approved = await requestApproval(tc.name, tc.input);
      if (approved === 'cancel') return { stopped: true, content: '' };
      let result;
      if (approved) result = await tools.execute(tc.name, tc.input, workspace);
      else result = { ok: false, error: 'El usuario rechazó esta acción.' };
      onEvent({ type: 'tool_result', id: tc.id, name: tc.name, ok: result.ok, output: result.error || result.output });
      results.push({ toolCallId: tc.id, name: tc.name, result });
    }
    convo.push({ role: 'tool', results });
  }

  return { content: 'El agente alcanzó el límite de pasos sin terminar. Resume lo hecho o pide indicaciones.', limitReached: true };
}

module.exports = { runAgent };
