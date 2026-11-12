'use strict';
const { createHash } = require('node:crypto');

const { fileInstructions: instructions, filePromptFor: promptFor } = require('./generation-prompts.cjs');
const textSchema = { type: 'string', minLength: 1, pattern: '\\S' };
const resultSchema = {
  type: 'object', additionalProperties: false, required: ['facts'], properties: {
    facts: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'statement', 'cards'], properties: {
        name: textSchema, statement: textSchema,
        cards: { type: 'array', minItems: 1, items: {
          type: 'object', additionalProperties: false, required: ['question', 'answer'],
          properties: { question: textSchema, answer: textSchema },
        } },
      },
    } },
  },
};
const fail = message => { throw new Error(message); };
function nonblank(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must not be blank.`);
}
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`${label} has unsupported fields.`);
  if (keys.some(key => !Object.hasOwn(value, key))) fail(`${label} is missing required fields.`);
}
function validateResult(result) {
  object(result, ['facts'], 'Result');
  if (!Array.isArray(result.facts)) fail('Return a facts array.');
  const statements = new Set(), questions = new Set();
  for (const fact of result.facts) {
    object(fact, ['name', 'statement', 'cards'], 'Fact');
    nonblank(fact.name, 'Fact name'); nonblank(fact.statement, 'Fact statement');
    const statement = fact.statement.trim();
    if (statements.has(statement)) fail('Duplicate fact statement; return each distinct fact only once.');
    statements.add(statement);
    if (!Array.isArray(fact.cards) || !fact.cards.length) fail('Each fact needs at least one card.');
    for (const card of fact.cards) {
      object(card, ['question', 'answer'], 'Card');
      nonblank(card.question, 'Question'); nonblank(card.answer, 'Answer');
      const question = card.question.trim();
      if (questions.has(question)) fail('Duplicate question; propose a distinct useful cue.');
      questions.add(question);
    }
  }
}
const high = code => code >= 0xd800 && code <= 0xdbff;
const low = code => code >= 0xdc00 && code <= 0xdfff;
function validUnicode(text) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (high(code)) { if (!low(text.charCodeAt(++index))) return false; }
    else if (low(code)) return false;
  }
  return true;
}
function validateFileInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('File input must be an object.');
  const { name, markdown } = input;
  nonblank(name, 'File name');
  if (/\p{Cc}/u.test(name)) fail('File name must not contain control characters.');
  if (typeof markdown !== 'string' || !markdown.trim()) fail('Source Markdown must not be empty.');
  if (!validUnicode(markdown)) fail('Source Markdown must contain valid Unicode, without unpaired surrogates.');
  if (Buffer.byteLength(markdown, 'utf8') > 2 * 1024 * 1024) fail('Source Markdown exceeds the 2 MiB UTF-8 limit.');
  const fingerprint = createHash('sha256').update(JSON.stringify([name, markdown]), 'utf8').digest('hex');
  return { name, markdown, fingerprint };
}
const estimate = prompt => Math.ceil(Buffer.byteLength(instructions + JSON.stringify(resultSchema) + prompt, 'utf8') / 3) + 256;
function prepareFileChunks(options) {
  const { name, markdown } = validateFileInput(options);
  const { chunkBudget, entry, ranges } = options;
  if (!Number.isSafeInteger(chunkBudget) || chunkBudget < 1) fail('Input budget must be a positive safe whole number.');
  if (!entry || typeof entry !== 'object') fail('A model catalog entry is required.');
  const outputLimit = entry.maxTokens ?? 8192, contextLimit = entry.contextWindow ?? Infinity;
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 1024 || (contextLimit !== Infinity && (!Number.isSafeInteger(contextLimit) || contextLimit < 1))) fail('The selected model cannot fit this context and an output allowance of at least 1024 tokens.');
  const boundary = offset => !(offset > 0 && offset < markdown.length && high(markdown.charCodeAt(offset - 1)) && low(markdown.charCodeAt(offset)));
  if (ranges !== undefined && !Array.isArray(ranges)) fail('Source ranges must be an array.');
  const spans = ranges === undefined ? [{ start: 0, end: markdown.length }] : ranges.map(range => {
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > markdown.length || !boundary(range.start) || !boundary(range.end)) fail('Each source range must have valid, nonempty UTF-16 offsets at Unicode code-point boundaries.');
    return { start: range.start, end: range.end };
  });
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  if (ordered.some((span, index) => index && span.start < ordered[index - 1].end)) fail('Source ranges must not overlap.');
  const plan = (start, end) => {
    const input = { name, markdown: markdown.slice(start, end) }, prompt = promptFor(input);
    const tokens = estimate(prompt);
    const maxTokens = Math.min(8192, outputLimit, contextLimit - tokens - 256);
    return { start, end, input, prompt, tokens, maxTokens };
  };
  // Match core extraction's source-only chars/4 budget. Filename, JSON
  // escaping, instructions and schema remain in the full-request estimate.
  const characterAllowance = chunkBudget * 4;
  const chunks = [];
  for (const span of spans) {
    let start = span.start;
    while (start < span.end) {
      let end = Math.min(span.end, start + characterAllowance);
      if (!boundary(end)) end--;
      if (end < span.end) {
        const prefix = markdown.slice(start, end);
        let paragraphEnd = -1;
        for (const match of prefix.matchAll(/\r?\n[ \t]*\r?\n/g)) paragraphEnd = match.index + match[0].length;
        const newlineEnd = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r')) + 1;
        const preferred = paragraphEnd > 0 ? paragraphEnd : newlineEnd;
        if (preferred > 0) end = start + preferred;
      }
      const chunk = plan(start, end);
      if (chunk.maxTokens < 1024) fail('The selected model cannot fit this context and an output allowance. Reduce the chunk budget or choose another model.');
      chunks.push(chunk); start = end;
    }
  }
  return chunks;
}

module.exports = { instructions, resultSchema, validateResult, validateFileInput, prepareFileChunks };
