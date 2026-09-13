// 3社のプロバイダ定義と送信アダプタ。
//
// 設計の核: UI から見た送信口は send() ひとつだけ。
//   mode 'share' -> 共有シートを開いて終わり。回答は後から Share Target で戻る（非同期・無期限）
//   mode 'api'   -> fetch して回答をその場で返す（非同期・数秒）
// どちらも「送った時点では回答が無い」という同じ形にしてあるので、
// UI 側は mode を一切意識しない。モード切替は設定トグル1つで効く。

export const PROVIDERS = [
  {
    id: 'openai',
    name: 'ChatGPT',
    short: 'GPT',
    color: '#10a37f',
    // NOTE: モデルIDは各社の公式ドキュメントで要確認。設定画面から変更可。
    // 公式価格表で確認（2026-09-13）
    //   gpt-5.6-terra $2/$12 ／ gpt-5.6-sol $4/$20 ／ gpt-6-astra $10/$50
    // Chat Completions でも新モデルは使える（Responses API 推奨だが必須ではない）
    defaultModel: 'gpt-5.6-terra',
    defaultModelDeep: 'gpt-5.6-sol',
    price: { in: 2, out: 12, inDeep: 4, outDeep: 20 },
    keyHint: 'platform.openai.com で発行 (sk-...)',
    web: 'https://chatgpt.com/',
    promptParam: 'q',   // 実機確認済み
  },
  {
    id: 'anthropic',
    name: 'Claude',
    short: 'CLD',
    color: '#d97757',
    // 公式価格で確認（2026-09-13）: Sonnet 5 $2/$10 ／ Opus 5 $5/$25
    defaultModel: 'claude-sonnet-5',
    defaultModelDeep: 'claude-opus-5',
    price: { in: 2, out: 10, inDeep: 5, outDeep: 25 },
    keyHint: 'console.anthropic.com で発行 (sk-ant-...)',
    web: 'https://claude.ai/new',
    promptParam: 'q',   // 実機確認済み
  },
  {
    id: 'google',
    name: 'Gemini',
    short: 'GEM',
    color: '#4285f4',
    // 公式価格表で確認（2026-09-13）
    //   gemini-3.8-flash は無料枠あり。有料時 $0.75/$3.75（2026-12-31まで。以降 $1.50/$7.50）
    //   gemini-3.1-pro-preview は無料枠なし $2/$12（200k超は $4/$18）
    //   無料で Pro 級が要るなら gemini-2.5-pro（無料枠あり／有料 $1.25/$10）に変える
    defaultModel: 'gemini-3.8-flash',
    defaultModelDeep: 'gemini-3.1-pro-preview',
    price: { in: 0.75, out: 3.75, inDeep: 2, outDeep: 12 },
    keyHint: 'aistudio.google.com で発行（無料枠あり）',
    web: 'https://gemini.google.com/app',
    promptParam: null,  // ?q= は無視される。貼り付けが要る
  },
];

export const PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

export const STATUS = {
  IDLE: 'idle',       // 未送信
  PENDING: 'pending', // 送信済み・回答待ち
  DONE: 'done',       // 回答あり
  ERROR: 'error',
};

// ---------------------------------------------------------------- share mode

export function canShare() {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

// URL にプロンプトを載せて開けば、相手先での貼り付け操作が丸ごと消える。
//
// 実機で確認した結果（2026-09-13）:
//   ChatGPT … ?q= が効く（?prompt= に転送され入力欄に入る。送信は手動）
//   Claude  … ?q= が効く（入力欄に入る。送信は手動）
//   Gemini  … ?q= は無視される。パラメータごと捨てられ空の画面が開く
//
// 対応していない相手にはクリップボード経由で渡すしかないので、
// UI 側でボタンの文言を変えて「貼り付けが要る」と分かるようにしている。
const DEEPLINK_MAX = 1500;

export function supportsDeepLink(providerId) {
  const p = PROVIDER_BY_ID[providerId];
  return !!(p && p.web && p.promptParam);
}

export function deepLink(providerId, prompt) {
  const p = PROVIDER_BY_ID[providerId];
  if (!supportsDeepLink(providerId)) return null;
  const q = encodeURIComponent(prompt || '');
  // 長いプロンプト（相互レビュー等）は URL 長の上限に当たるので載せない
  if (!q || q.length > DEEPLINK_MAX) return null;
  return p.web + (p.web.indexOf('?') === -1 ? '?' : '&') + p.promptParam + '=' + q;
}

/** そのターンのプロンプトが実際にURLで渡せるか（長さも込みで判定） */
export function canCarryPrompt(providerId, prompt) {
  return deepLink(providerId, prompt) !== null;
}

export function isAndroid() {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
}

/**
 * 端末ごとの手動送受信の方式を決める。
 *
 * 'share' … 共有シートに投げる／回答は Share Target で自動で戻る（Android）
 * 'copy'  … クリップボードに載せて各社Webを開く／回答は貼り戻す（PC）
 *
 * canShare() だけでは判定できない。デスクトップ版 Chrome も navigator.share を
 * 持っていて OS の共有シートが開いてしまうが、そこに各社アプリは並ばない。
 * よって Android かどうかを併せて見る。設定から明示的に上書きできる。
 */
export function resolveTransport(pref) {
  if (pref === 'share' || pref === 'copy') return pref;
  return isAndroid() && canShare() ? 'share' : 'copy';
}

// 共有APIもクリップボードも使えないときに UI 側が差し込む最終手段
let manualCopyHandler = null;
export function setManualCopyHandler(fn) {
  manualCopyHandler = fn;
}

// ------------------------------------------------------------------ api mode

async function callOpenAI({ apiKey, model, messages }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    usage: {
      input: json.usage?.prompt_tokens ?? 0,
      output: json.usage?.completion_tokens ?? 0,
    },
  };
}

async function callAnthropic({ apiKey, model, messages }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // ブラウザから直接叩くための明示的オプトイン。
      // サーバ経由に移す段階でこのヘッダごと消す。
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: 16000, messages }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const json = await res.json();
  // Opus 5 系は安全性分類器で応答を断ることがある（HTTP 200 + stop_reason: refusal）
  if (json.stop_reason === 'refusal') {
    throw new Error(`Claudeが応答を拒否しました (${json.stop_details?.category ?? 'unknown'})`);
  }
  return (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

async function callGoogle({ apiKey, model, messages }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return {
    text: (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
    usage: {
      input: json.usageMetadata?.promptTokenCount ?? 0,
      output: json.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

const API_CALLERS = {
  openai: callOpenAI,
  anthropic: callAnthropic,
  google: callGoogle,
};

// ------------------------------------------------------------------ 統一入口

/**
 * @param {string} providerId
 * @param {object} cfg  設定 { mode, apiKey, model }
 * @param {Array}  messages  [{role:'user'|'assistant'|'system', content}]
 * @param  {object} [opts]  { transport: 'auto'|'share'|'copy' }
 * @returns {Promise<{mode:'manual', via:string}|{mode:'api', text:string}>}
 */
export async function send(providerId, cfg, messages, opts) {
  if (cfg.mode === 'api') {
    if (!cfg.apiKey) throw new Error('APIキーが未設定です');
    const caller = API_CALLERS[providerId];
    // 1往復目は中位、深堀りだけ上位。ここが費用の効きどころ。
    const tier = (opts && opts.tier) === 'deep' ? 'deep' : 'normal';
    const model = tier === 'deep'
      ? (cfg.modelDeep || cfg.model || PROVIDER_BY_ID[providerId].defaultModelDeep)
      : (cfg.model || PROVIDER_BY_ID[providerId].defaultModel);
    const res = await caller({ apiKey: cfg.apiKey, model, messages });
    return { mode: 'api', text: res.text, usage: res.usage, model, tier };
  }

  // 手動モード: 共有もコピーも毎回「新しいチャット」を開くため、相手側に履歴が残らない。
  // よって履歴を畳み込むのではなく、prompt.js が組み立てた
  // 「文脈を内包した自己完結プロンプト」の最後の1本だけを送る。
  // （全履歴を畳むと操作ごとに肥大化し、共有インテントのサイズ上限にも当たる）
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const text = last ? last.content : '';
  const transport = resolveTransport(opts && opts.transport);

  if (transport === 'share' && canShare()) {
    await navigator.share({ text });
    return { mode: 'manual', via: 'share' };
  }

  // クリップボードは権限やフォーカス状態で普通に失敗するので、
  // 失敗しても送信自体は成立させ、手動コピー用のUIに逃がす。
  try {
    await navigator.clipboard.writeText(text);
    return { mode: 'manual', via: 'clipboard' };
  } catch (err) {
    if (!manualCopyHandler) throw err;
    await manualCopyHandler(text);
    return { mode: 'manual', via: 'dialog' };
  }
}

/** PC で回答を戻すとき用。クリップボードから直接読む。 */
export async function readClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    throw new Error('この環境ではクリップボードを読み取れません');
  }
  return (await navigator.clipboard.readText()).trim();
}
