// 深堀りプロンプトの自動生成。
// ここが「集約」の実体。手作業で残るのは共有シートのタップだけで、
// 何を聞くかの組み立ては全部こちらで持つ。

import { PROVIDER_BY_ID } from './providers.js';

/** そのプロバイダとの1対1の履歴を messages 配列に組む */
export function historyFor(turns, providerId) {
  const messages = [];
  for (const turn of turns) {
    const ans = turn.answers[providerId];
    // そのプロバイダに投げていないターンは履歴に含めない
    if (!ans || ans.status === 'idle') continue;
    messages.push({ role: 'user', content: turn.promptFor?.[providerId] ?? turn.question });
    if (ans.status === 'done' && ans.text) {
      messages.push({ role: 'assistant', content: ans.text });
    }
  }
  return messages;
}

/** 3社の回答を並べたブロック（再質問プロンプトの素材） */
function answersBlock(turn, { exclude } = {}) {
  return Object.entries(turn.answers)
    .filter(([id, a]) => a.status === 'done' && a.text && id !== exclude)
    .map(([id, a]) => `### ${PROVIDER_BY_ID[id].name} の回答\n${a.text}`)
    .join('\n\n');
}

/** 「3社にまた投げる」: 全員の回答を踏まえた再質問 */
export function buildCrossPrompt(turn, followUp) {
  const block = answersBlock(turn);
  return [
    `以下は「${turn.question}」という質問に対する、複数のAIからの回答です。`,
    '',
    block,
    '',
    '---',
    '',
    followUp,
  ].join('\n');
}

/** 「他2社を見せて批評させる」: 相互レビュー */
export function buildCritiquePrompt(turn, providerId) {
  const others = answersBlock(turn, { exclude: providerId });
  return [
    `先ほどの「${turn.question}」について、他のAIは次のように答えました。`,
    '',
    others,
    '',
    '---',
    '',
    'これらを読んだ上で、次を簡潔に述べてください。',
    '1. あなたの回答と食い違う点、その理由',
    '2. 他の回答のほうが優れている点（あれば率直に）',
    '3. 3つを統合した場合の結論',
  ].join('\n');
}

/** 「この部分について深堀り」: 引用付きの個別追撃 */
export function buildQuotePrompt(quote, followUp) {
  return [
    'あなたの回答のうち、次の部分について掘り下げます。',
    '',
    quote.split('\n').map((l) => `> ${l}`).join('\n'),
    '',
    followUp,
  ].join('\n');
}
