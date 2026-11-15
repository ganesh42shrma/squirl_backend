const assert = require('node:assert/strict');
const llm = require('../src/plugins/insights/llm.client');
const { generateQuote } = require('../src/plugins/ai/quote.service');
const schemas = require('../src/plugins/ai/ai.validation');
const controller = require('../src/plugins/ai/ai.controller');

async function main() {
  const calls = [];
  let answer = JSON.stringify({ text: 'A steady step today is a promise kept to tomorrow.' });
  const original = llm.chat;
  llm.chat = async (messages, options) => {
    calls.push({ messages, options });
    return { text: answer };
  };
  try {
    assert.equal(schemas.quote.safeParse({}).success, true);
    assert.equal(schemas.quote.safeParse({ body: {} }).success, true);
    assert.equal(schemas.quote.safeParse({ body: { previous: 'x'.repeat(241) } }).success, false);
    assert.equal(schemas.quote.safeParse({ body: { transactions: [] } }).success, false);

    const first = await generateQuote('synthetic-user');
    assert.equal(first.text, JSON.parse(answer).text);
    assert.ok(['Anime-inspired', 'Stoic-inspired', 'Motivational'].includes(first.style));
    assert.equal(calls.length, 1, 'one completion per request');
    assert.equal(calls[0].options.userId, 'synthetic-user', 'use the signed-in person’s configured engine');
    assert.equal(calls[0].options.reasoning, 'none');
    assert.equal(calls[0].options.json, true);
    assert.deepEqual(Object.keys(JSON.parse(calls[0].messages[1].content)).sort(), ['style', 'variation']);

    await generateQuote('synthetic-user', { previous: first.text });
    assert.equal(calls.length, 2, 'refresh never uses a cached answer');
    const secondPrompt = JSON.parse(calls[1].messages[1].content);
    assert.equal(secondPrompt.previous, first.text);
    assert.notEqual(secondPrompt.variation, JSON.parse(calls[0].messages[1].content).variation);

    let response;
    await controller.quote({ user: { id: 'second-user' }, body: {} }, {
      status(code) { assert.equal(code, 200); return this; },
      json(body) { response = body; },
    });
    assert.equal(response.success, true);
    assert.equal(calls.at(-1).options.userId, 'second-user');

    for (const bad of ['not JSON', '{}', '{"text":42}', JSON.stringify({ text: 'x'.repeat(241) })]) {
      answer = bad;
      await assert.rejects(generateQuote('synthetic-user'), (err) => err.code === 'LLM_BAD_RESPONSE');
    }
    answer = JSON.stringify({ text: '  A steady step\n today is enough to keep going.  ' });
    assert.equal((await generateQuote('synthetic-user')).text, 'A steady step today is enough to keep going.');
    llm.chat = async () => { throw new Error('synthetic model outage'); };
    await assert.rejects(generateQuote('synthetic-user'), /synthetic model outage/);
    console.log('Quotes: fresh calls, user engine routing, bounded input/output, previous-line context and model failures passed. No live AI calls.');
  } finally {
    llm.chat = original;
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
