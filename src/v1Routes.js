const express = require('express');
const { authenticate } = require('./auth');
const { rateLimit } = require('./rateLimit');
const { requireScope } = require('./scopes');
const { quotaAlert } = require('./quota');
const { MODELS, thinkTimeMs, fakeCompletion } = require('./dummyData');

const router = express.Router();

router.use(authenticate, rateLimit, requireScope, quotaAlert);

router.get('/models', (req, res) => {
  res.json({ object: 'list', data: MODELS });
});

router.post('/chat/completions', async (req, res) => {
  const { model, messages } = req.body || {};

  if (!MODELS.some((m) => m.id === model)) {
    return res.status(400).json({
      error: 'invalid_model',
      message: `model must be one of: ${MODELS.map((m) => m.id).join(', ')}`,
    });
  }

  const valid =
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.length <= 20 &&
    messages.every(
      (m) =>
        ['system', 'user', 'assistant'].includes(m?.role) &&
        typeof m?.content === 'string' &&
        m.content.length <= 2000
    );
  if (!valid) {
    return res.status(400).json({
      error: 'invalid_messages',
      message: 'messages must be 1 to 20 items, each with a role and a text content of at most 2000 characters',
    });
  }

  await new Promise((resolve) => setTimeout(resolve, thinkTimeMs(model)));
  const completion = fakeCompletion(model, messages);
  res.locals.tokens = completion.usage.total_tokens;
  res.json(completion);
});

module.exports = router;