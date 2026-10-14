const crypto = require('crypto');

const MODELS = [
  { id: 'dummy-small', description: 'Fast and cheap, fake answers', context_window: 4096 },
  { id: 'dummy-medium', description: 'Balanced, fake answers', context_window: 16384 },
  { id: 'dummy-large', description: 'Slow and thoughtful, fake answers', context_window: 65536 },
];

// How long each fake model "thinks", in milliseconds: [minimum, extra random part]
const THINK_TIME = {
  'dummy-small': [80, 150],
  'dummy-medium': [200, 250],
  'dummy-large': [400, 400],
};

function thinkTimeMs(model) {
  const [min, extra] = THINK_TIME[model];
  return min + Math.random() * extra;
}

function fakeCompletion(model, messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = String(lastUser?.content || '');
  const reply = `This is a dummy reply from ${model}. You said: "${prompt.slice(0, 80)}"`;

  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
  const completionTokens = Math.ceil(reply.length / 4);

  return {
    id: 'chatcmpl-' + crypto.randomBytes(6).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

module.exports = { MODELS, thinkTimeMs, fakeCompletion };