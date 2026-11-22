// Reading sheet music (vision model) and editing ABC (text model) through mux.

import { extractAbc, validateAbc, getTitle } from './abc.js';
import { chat, MuxError } from './mux.js';
import {
  OMR_SYSTEM,
  OMR_INSTRUCTIONS,
  omrRetryMessage,
  EDIT_SYSTEM,
  editUserMessage,
  editRetryMessage,
} from './prompts.js';

const NOT_MUSIC_ERROR = 'Billedet ser ikke ud til at indeholde noder. Tag et billede, hvor nodelinjerne fylder det meste af billedet.';

function checkAnswer(content, finishReason) {
  const abc = extractAbc(content);
  const result = validateAbc(abc);
  if (!result.ok && finishReason === 'length') {
    result.errors.push('The answer was cut off (too long). Write a shorter analysis and only the ABC.');
  }
  return result;
}

/**
 * Turn a JPEG of sheet music into ABC.
 * @returns {Promise<{abc:string, title:string|null, warnings:string[]}>}
 */
export async function readSheet(config, jpeg, { fetchImpl } = {}) {
  const dataUri = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  const messages = [
    { role: 'system', content: OMR_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: OMR_INSTRUCTIONS },
        { type: 'image_url', image_url: { url: dataUri } },
      ],
    },
  ];

  const first = await chat(config, { model: config.visionModel, messages, maxTokens: 4000, temperature: 0, fetchImpl });
  if (/^\s*NOT_MUSIC\b/.test(first.content) && !extractAbc(first.content)) {
    throw new MuxError(NOT_MUSIC_ERROR, 422, 'not_music');
  }
  let result = checkAnswer(first.content, first.finishReason);

  if (!result.ok) {
    console.warn(`[read] first answer invalid: ${result.errors.join(' | ')}; retrying once`);
    const retryMessages = [
      ...messages,
      { role: 'assistant', content: first.content || '(empty answer)' },
      { role: 'user', content: omrRetryMessage(result.errors) },
    ];
    const second = await chat(config, {
      model: config.visionModel,
      messages: retryMessages,
      maxTokens: 4000,
      temperature: 0,
      fetchImpl,
    });
    if (/^\s*NOT_MUSIC\b/.test(second.content) && !extractAbc(second.content)) {
      throw new MuxError(NOT_MUSIC_ERROR, 422, 'not_music');
    }
    result = checkAnswer(second.content, second.finishReason);
    if (!result.ok) {
      console.warn(`[read] retry answer invalid: ${result.errors.join(' | ')}`);
      throw new MuxError(
        'Noderne kunne ikke læses. Prøv et nyt billede: hold telefonen lige over siden, sørg for godt lys, og få kun én sang med.',
        422,
        'unreadable',
      );
    }
  }

  return {
    abc: result.abc,
    title: getTitle(result.abc),
    warnings: [...result.notes, ...result.warnings],
  };
}

/** Text before the first code fence, as the explanation. */
function explanationOf(content) {
  const s = (content || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const idx = s.search(/(^|\n)[ \t]*(`{3,}|~{3,})/);
  const text = (idx >= 0 ? s.slice(0, idx) : s).trim();
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Change an ABC tune (or answer a question about it) following a Danish instruction.
 * @returns {Promise<{abc:string, explanation:string}>}
 */
export async function editAbc(config, abc, instruction, { fetchImpl } = {}) {
  const messages = [
    { role: 'system', content: EDIT_SYSTEM },
    { role: 'user', content: editUserMessage(abc, instruction) },
  ];
  const first = await chat(config, { model: config.textModel, messages, maxTokens: 4000, temperature: 0, fetchImpl });

  let content = first.content;
  let extracted = extractAbc(content);
  // No ABC at all: the model answered a question in prose. Keep the tune unchanged.
  if (!extracted) {
    const explanation = explanationOf(content);
    if (!explanation) throw new MuxError('AI-modellen gav et tomt svar. Prøv igen.', 502, 'empty');
    return { abc, explanation };
  }

  let result = validateAbc(extracted);
  if (!result.ok) {
    console.warn(`[edit] first answer invalid: ${result.errors.join(' | ')}; retrying once`);
    const second = await chat(config, {
      model: config.textModel,
      messages: [...messages, { role: 'assistant', content }, { role: 'user', content: editRetryMessage(result.errors) }],
      maxTokens: 4000,
      temperature: 0,
      fetchImpl,
    });
    content = second.content;
    extracted = extractAbc(content);
    result = validateAbc(extracted);
    if (!result.ok) {
      throw new MuxError('Ændringen gav ikke gyldige noder. Prøv at formulere ønsket anderledes.', 422, 'invalid_edit');
    }
  }

  const explanation = explanationOf(content) || 'Noderne er opdateret.';
  return { abc: result.abc, explanation };
}
