import {
  PROVIDERS, PROVIDER_BY_ID, STATUS, send, setManualCopyHandler,
  resolveTransport, readClipboard, deepLink,
} from './providers.js';
import { historyFor, buildCrossPrompt, buildCritiquePrompt, buildQuotePrompt } from './prompt.js';
import * as db from './db.js';

const CHANNEL = 'triad-inbox';

// ---------------------------------------------------------------- state

let settings = null;
let turns = [];

function defaultSettings() {
  return {
    // 端末ごとの手動送受信の方式。プロバイダ設定とは別軸。
    // Android は共有シート、PC はコピー＋Webを開く、が既定（auto）。
    device: { transport: 'auto', autoCapture: true },
    providers: Object.fromEntries(
      PROVIDERS.map((p) => [p.id, { mode: 'share', apiKey: '', model: p.defaultModel, enabled: true }])
    ),
  };
}

function currentTransport() {
  return resolveTransport(settings.device && settings.device.transport);
}

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
}

function newTurn(question, promptFor, targets) {
  const answers = {};
  for (const p of PROVIDERS) {
    answers[p.id] = { status: targets.includes(p.id) ? STATUS.IDLE : 'skip', text: '', error: '' };
  }
  return { id: newId(), question, promptFor, createdAt: Date.now(), answers };
}

async function saveTurn(turn) {
  await db.put(db.STORE_TURNS, turn);
}

async function saveSettings() {
  await db.put(db.STORE_KV, settings, 'settings');
}

// ---------------------------------------------------------------- dom

const $ = (sel) => document.querySelector(sel);
const elTurns = $('#turns');
const elEmpty = $('#empty');
const elQ = $('#q');

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// 長い回答は畳む。閉じた状態は保存しない（セッション中だけの表示状態）。
const CLAMP_CHARS = 260;
const expandedKeys = new Set();
const keyOf = (turnId, pid) => `${turnId}:${pid}`;

function render() {
  elEmpty.hidden = turns.length > 0;
  elTurns.innerHTML = turns.map(renderTurn).join('');
  elTurns.scrollTop = elTurns.scrollHeight;
}

function renderTurn(turn) {
  const shown = PROVIDERS.filter((p) => turn.answers[p.id].status !== 'skip');
  const doneCount = shown.filter((p) => turn.answers[p.id].status === STATUS.DONE).length;
  const tag = turn.kind ? `<span class="tag">${esc(turn.kind)}</span>` : '';

  // 未送信が2社以上あるなら、1クリックでまとめて開けるようにする
  const idleCount = shown.filter((p) => turn.answers[p.id].status === STATUS.IDLE
    && settings.providers[p.id].mode !== 'api').length;
  const bulk = (idleCount > 1 && currentTransport() === 'copy')
    ? `<button data-turn="${turn.id}" data-act="goall" class="primary-sm">未送信の${idleCount}社をまとめて開く ↗</button>`
    : '';

  const later = doneCount > 0
    ? `<button data-turn="${turn.id}" data-act="cross">3社に再質問</button>
       <button data-turn="${turn.id}" data-act="critique" ${doneCount < 2 ? 'disabled' : ''}>相互レビューさせる</button>`
    : '';

  const actions = (bulk || later)
    ? `<div class="turn-actions">${bulk}${later}</div>`
    : '';

  return `<section class="turn">
    <div>
      <div class="qmeta">${tag}<span class="progress">${doneCount} / ${shown.length} 回答</span></div>
      <p class="q">${esc(turn.question)}</p>
    </div>
    <div class="cards">${shown.map((p) => renderCard(turn, p)).join('')}</div>
    ${actions}
  </section>`;
}

function renderCard(turn, p) {
  const a = turn.answers[p.id];
  const cfg = settings.providers[p.id];
  const btn = (act, label, cls) =>
    `<button class="${cls || ''}" data-turn="${turn.id}" data-p="${p.id}" data-act="${act}">${label}</button>`;

  // バッジは意味のあるときだけ出す。既定（手動）は無表示にして視覚ノイズを減らす。
  const ident = `<span class="pname">${esc(p.name)}</span>` +
    (cfg.mode === 'api' ? '<span class="pmode">API</span>' : '');

  // 回答が無い状態は1行に畳む。未送信カードが回答と同じ面積を食わないように。
  if (a.status !== STATUS.DONE) {
    const copyMode = cfg.mode !== 'api' && currentTransport() === 'copy';
    // PC は Share Target が無いので、戻す導線をここに出す
    const back = copyMode
      ? btn('readclip', 'クリップボードから貼る', 'primary-sm') + btn('paste', '手で貼る')
      : btn('paste', '手で貼る');

    let pill = '';
    let acts = '';
    if (a.status === STATUS.PENDING) {
      pill = '<span class="pill wait">回答待ち</span>';
      // 「開く」は送った後こそ要る。コピー直後に消すと相手先に行けない。
      acts = back + (copyMode ? btn('go', '開き直す ↗') : '') + btn('send', '再送');
    } else if (a.status === STATUS.ERROR) {
      pill = '<span class="pill err">エラー</span>';
      acts = btn('send', '再試行', 'primary-sm') + btn('paste', '手で貼る');
    } else {
      pill = '<span class="pill idle">未送信</span>';
      if (cfg.mode === 'api') acts = btn('send', '送信', 'primary-sm');
      // コピーと遷移を1アクションに統合。プロンプトはURLに載るので貼り付けも要らない。
      else if (copyMode) acts = btn('go', '開く ↗', 'primary-sm') + btn('send', 'コピーだけ');
      else acts = btn('send', '送る', 'primary-sm');
    }
    const note = a.status === STATUS.ERROR && a.error
      ? `<div class="cnote err">${esc(a.error)}</div>`
      : (a.note ? `<div class="cnote warn">${esc(a.note)}</div>` : '');

    return `<article class="card slim" style="--p:${p.color}">
      <div class="crow">${ident}${pill}<span class="grow"></span><span class="cacts">${acts}</span></div>
      ${note}
    </article>`;
  }

  const key = keyOf(turn.id, p.id);
  const long = a.text.length > CLAMP_CHARS;
  const open = !long || expandedKeys.has(key);

  return `<article class="card" style="--p:${p.color}">
    <div class="crow">${ident}<span class="grow"></span></div>
    <div class="body${open ? '' : ' clamped'}">${esc(a.text)}</div>
    ${long ? `<button class="more" data-turn="${turn.id}" data-p="${p.id}" data-act="toggle">${open ? '閉じる' : 'すべて表示'}</button>` : ''}
    <div class="cacts bottom">${btn('dig', '深堀り', 'primary-sm')}${btn('quote', '選択部分')}${btn('paste', '貼り直す')}</div>
  </article>`;
}

// ---------------------------------------------------------------- 送信

function priorTurns(turn) {
  const i = turns.findIndex((t) => t.id === turn.id);
  return i <= 0 ? [] : turns.slice(0, i);
}

async function sendOne(turnId, pid) {
  const turn = turns.find((t) => t.id === turnId);
  if (!turn) return;
  const cfg = settings.providers[pid];
  const a = turn.answers[pid];

  const messages = [
    ...historyFor(priorTurns(turn), pid),
    { role: 'user', content: turn.promptFor[pid] || turn.question },
  ];

  a.status = STATUS.PENDING;
  a.error = '';
  a.note = '';
  render();

  try {
    const res = await send(pid, cfg, messages, { transport: currentTransport() });
    if (res.mode === 'api') {
      a.status = STATUS.DONE;
      a.text = res.text;
    } else if (res.via === 'clipboard') {
      // 自分で載せたプロンプトを「戻ってきた回答」と誤認しないよう既知にしておく
      lastClipboardSeen = messages[messages.length - 1].content;
    }
    // share mode はここでは何も確定しない。回答は Share Target 経由で後から届く。
  } catch (err) {
    // 共有シートをユーザがキャンセルした場合も例外になるので、未送信に戻す
    const msg = String(err && err.message ? err.message : err);
    if (/abort/i.test(msg)) {
      a.status = STATUS.IDLE;
    } else {
      a.status = STATUS.ERROR;
      a.error = msg;
    }
  }
  await saveTurn(turn);
  render();
}

/**
 * 新しいターンを追加して、API モードのプロバイダにだけ自動送信する。
 *
 * 共有モードを自動で3連発できない理由:
 *   navigator.share() は「ユーザ操作直後」でないと拒否される（transient activation）。
 *   await を挟んだ2回目以降は必ず失敗するため、共有は1タップ1社が構造的な上限。
 */
async function addTurn(turn) {
  turns.push(turn);
  await saveTurn(turn);
  render();
  for (const p of PROVIDERS) {
    if (turn.answers[p.id].status !== STATUS.IDLE) continue;
    if (settings.providers[p.id].mode === 'api') await sendOne(turn.id, p.id);
  }
}

function activeTargets() {
  return PROVIDERS.filter((p) => settings.providers[p.id].enabled).map((p) => p.id);
}

async function ask(question) {
  const targets = activeTargets();
  if (!targets.length) {
    alert('設定で少なくとも1社を有効にしてください。');
    return;
  }
  const promptFor = Object.fromEntries(targets.map((id) => [id, question]));
  await addTurn(newTurn(question, promptFor, targets));
}

// ---------------------------------------------------------------- 遷移と自動取り込み

// 直近に開いた相手。戻ってきたクリップボードを誰の回答とみなすかの根拠にする。
let lastOpened = null;
// 既にページ上で見たクリップボード内容。これと同じなら「新しく戻ってきた」ではない。
let lastClipboardSeen = null;

function openProvider(turn, pid) {
  const prompt = turn.promptFor[pid] || turn.question;
  const url = deepLink(pid, prompt) || PROVIDER_BY_ID[pid].web;
  window.open(url, '_blank', 'noopener');
  lastOpened = { turnId: turn.id, pid, at: Date.now() };
}

function toast(message, onUndo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (onUndo) {
    const b = document.createElement('button');
    b.textContent = '取り消す';
    b.addEventListener('click', () => { el.hidden = true; onUndo(); });
    el.appendChild(b);
  }
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 6000);
}

/**
 * Triad に戻ってきた瞬間にクリップボードを見て、回答待ちの相手に自動で入れる。
 * これが手数削減の本体（戻る→ボタンを押す、が消える）。
 *
 * 誤爆させないための条件:
 *   - コピー方式かつ設定が有効
 *   - 前回見た内容と違う（＝その間に何かコピーした）
 *   - 送ったプロンプトのエコーではない（assign 側の block ガード）
 *   - 宛先が一意に決まる（直近に開いた相手、または回答待ちが1つだけ）
 */
async function autoCapture() {
  if (document.hidden) return;
  if (currentTransport() !== 'copy') return;
  if (!settings.device.autoCapture) return;

  let text;
  try {
    text = await readClipboard();
  } catch (err) {
    return; // 権限が無い環境では黙って何もしない
  }
  if (!text || text === lastClipboardSeen) return;
  lastClipboardSeen = text;

  const slots = pendingSlots();
  if (!slots.length) return;

  let slot = lastOpened
    ? slots.find((s) => s.turn.id === lastOpened.turnId && s.pid === lastOpened.pid)
    : null;
  if (!slot && slots.length === 1) slot = slots[0];
  if (!slot) return; // 宛先が絞れないときは黙って見送る

  const before = { status: slot.turn.answers[slot.pid].status, text: slot.turn.answers[slot.pid].text };
  const ok = await assign(slot.turn, slot.pid, text);
  if (!ok) return;

  toast(`${PROVIDER_BY_ID[slot.pid].name} の回答を取り込みました`, async () => {
    const a = slot.turn.answers[slot.pid];
    a.status = before.status;
    a.text = before.text;
    await saveTurn(slot.turn);
    render();
  });
}

// ---------------------------------------------------------------- inbox 帰属

let inboxBusy = false;

async function processInbox() {
  if (inboxBusy) return;
  inboxBusy = true;
  try {
    const items = await db.drainInbox();
    for (const item of items) {
      await attribute(item);
      await db.del(db.STORE_INBOX, item.id);
    }
  } finally {
    inboxBusy = false;
  }
}

/** 回答待ちの (turn, provider) を新しい順に集める */
function pendingSlots() {
  const slots = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    for (const p of PROVIDERS) {
      if (turn.answers[p.id].status === STATUS.PENDING) slots.push({ turn, pid: p.id });
    }
  }
  return slots;
}

async function attribute(item) {
  let slots = pendingSlots();

  // 回答待ちが1つだけなら確認不要 -- ここが「1社ずつ送る」運用の見返り
  if (slots.length === 1) {
    await assign(slots[0].turn, slots[0].pid, item.text);
    return;
  }

  // 待ちが無い場合は、最新ターンの全プロバイダを候補にする（貼り直し等）
  if (slots.length === 0) {
    const last = turns[turns.length - 1];
    if (!last) return;
    slots = PROVIDERS
      .filter((p) => last.answers[p.id].status !== 'skip')
      .map((p) => ({ turn: last, pid: p.id }));
  }

  const picked = await askPick(item.text, slots);
  if (!picked) return; // 破棄
  await assign(picked.turn, picked.pid, item.text);
}

const squash = (v) => String(v == null ? '' : v).replace(/\s+/g, '');

/**
 * 「回答のつもりで、送ったプロンプトそのものを貼ってしまった」を検出する。
 *
 * コピー方式では、送信＝クリップボードにプロンプトを載せることなので、
 * 相手先で回答をコピーし忘れたまま「クリップボードから貼る」を押すと、
 * 質問文がそのまま回答として登録されてしまう。黙って通すと気づけない。
 */
function looksLikeEcho(turn, pid, text) {
  const sent = squash(turn.promptFor[pid] || turn.question);
  const got = squash(text);
  if (!sent || !got) return false;
  if (got === sent) return true;
  // プロンプトの一部だけが戻ってきた場合（コピー範囲のずれ）も拾う
  return sent.length > 20 && sent.indexOf(got) !== -1 && got.length >= sent.length * 0.8;
}

/**
 * @param {object} opts
 *   opts.guard: 'block'（既定・エコーなら登録しない）| 'confirm'（確認して続行可）
 *
 * クリップボード経由の取り込みは block にしてある。confirm では弱い:
 * 一番起きやすいのが「回答をコピーし忘れて押した」なので、
 * Enter や連打で素通りできる確認では取りこぼす。手で貼った場合だけ
 * 「本当にそれでいい」があり得るので、そちらは confirm にする。
 */
async function assign(turn, pid, text, opts) {
  const guard = (opts && opts.guard) || 'block';
  const a = turn.answers[pid];

  if (looksLikeEcho(turn, pid, text)) {
    if (guard === 'block') {
      a.note = 'クリップボードの中身が送信したプロンプトのままです。'
        + '相手側で回答をコピーしてから、もう一度押してください。';
      render();
      return false;
    }
    const ok = confirm(
      '貼り付けた内容が、送信したプロンプトとほぼ同じです。'
      + '回答ではなく質問文をコピーしていませんか？'
    );
    if (!ok) return false;
  }

  a.status = STATUS.DONE;
  a.text = text;
  a.error = '';
  a.note = '';
  await saveTurn(turn);
  render();
  return true;
}

/**
 * ダイアログを開いて、OK なら getValue(押されたボタン) の結果、それ以外は null を返す。
 *
 * close イベントには依存しない。dialog の close/cancel は環境によって
 * 一切発火しないことがあり（実測で遭遇）、そこで待ち合わせると
 * ダイアログを閉じても処理が永久に進まなくなる。
 * 押されたボタンの click を一次情報にし、close/cancel は保険として併用する。
 */
function runDialog(dlg, getValue) {
  return new Promise((resolve) => {
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      dlg.removeEventListener('click', onClick);
      dlg.removeEventListener('close', onClose);
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      resolve(value);
    };

    const onClick = (e) => {
      const btn = e.target.closest('button');
      if (!btn || !dlg.contains(btn)) return;
      finish(getValue(btn));
    };
    const onClose = () => finish(dlg.returnValue === 'ok' ? getValue(null) : null);
    const onCancel = () => finish(null);

    dlg.addEventListener('click', onClick);
    dlg.addEventListener('close', onClose);
    dlg.addEventListener('cancel', onCancel);
    dlg.returnValue = '';
    dlg.showModal();
  });
}

function askPick(text, slots) {
  const dlg = $('#dlg-pick');
  $('#pick-preview').textContent = text.slice(0, 600);
  $('#pick-options').innerHTML = slots.map((s, i) => {
    const p = PROVIDER_BY_ID[s.pid];
    return `<button type="button" data-i="${i}">
      ${esc(p.name)}
      <span class="sub">${esc(s.turn.question.slice(0, 48))}</span>
    </button>`;
  }).join('');

  return runDialog(dlg, (btn) => {
    if (!btn || btn.dataset.i === undefined) return null; // 破棄 / Esc
    return slots[Number(btn.dataset.i)];
  });
}

// ---------------------------------------------------------------- ダイアログ入力

function askText(dlgSel, textSel, opts) {
  const o = opts || {};
  const dlg = $(dlgSel);
  if (o.title) dlg.querySelector('h2').textContent = o.title;
  const descEl = dlg.querySelector('p.dim');
  if (descEl && o.desc !== undefined) descEl.textContent = o.desc;
  const ta = $(textSel);
  ta.value = o.value || '';

  const promise = runDialog(dlg, (btn) => {
    const ok = btn ? btn.value === 'ok' : dlg.returnValue === 'ok';
    return ok ? ta.value.trim() : null;
  });
  ta.focus();
  return promise;
}

function showCopyDialog(text) {
  const dlg = $('#dlg-copy');
  $('#copy-text').value = text;
  const promise = runDialog(dlg, () => null);
  $('#copy-text').select();
  return promise;
}

// 共有APIもクリップボードも無い環境（主にPC）の最終手段
setManualCopyHandler(showCopyDialog);

// ---------------------------------------------------------------- イベント

elTurns.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const turnId = btn.dataset.turn;
  const pid = btn.dataset.p;
  const act = btn.dataset.act;
  const turn = turns.find((t) => t.id === turnId);
  if (!turn) return;

  if (act === 'toggle') {
    const key = keyOf(turnId, pid);
    if (expandedKeys.has(key)) expandedKeys.delete(key);
    else expandedKeys.add(key);
    render();
    return;
  }

  if (act === 'send') {
    await sendOne(turnId, pid);
    return;
  }

  if (act === 'open') {
    // クリック直後に開く。await を挟むとポップアップブロックに当たる。
    window.open(PROVIDER_BY_ID[pid].web, '_blank', 'noopener');
    return;
  }

  // コピー + 遷移をまとめて1アクションに
  if (act === 'go') {
    openProvider(turn, pid);
    await sendOne(turnId, pid);
    return;
  }

  if (act === 'goall') {
    // 1回のユーザ操作の中でまとめて開く。await を挟むとポップアップが止まるので、
    // window.open を先に全部済ませてから状態更新する。
    const targets = PROVIDERS.filter((p) =>
      turn.answers[p.id].status === STATUS.IDLE && settings.providers[p.id].mode !== 'api');
    for (const p of targets) openProvider(turn, p.id);
    for (const p of targets) await sendOne(turnId, p.id);
    return;
  }

  if (act === 'readclip') {
    try {
      const text = await readClipboard();
      if (!text) {
        turn.answers[pid].note = 'クリップボードが空です。回答をコピーしてから押してください。';
        render();
        return;
      }
      // guard は既定の block。エコーならカード上に理由を出して登録しない。
      await assign(turn, pid, text);
    } catch (err) {
      // 読み取り権限が無い環境は手貼りに落とす
      const text = await askText('#dlg-paste', '#paste-text', {
        desc: `クリップボードを読めませんでした。${PROVIDER_BY_ID[pid].name} の回答を貼り付けてください。`,
        value: '',
      });
      if (text) await assign(turn, pid, text, { guard: 'confirm' });
    }
    return;
  }

  if (act === 'paste') {
    const text = await askText('#dlg-paste', '#paste-text', {
      desc: `${PROVIDER_BY_ID[pid].name} の回答を貼り付けてください。`,
      value: turn.answers[pid].text || '',
    });
    // 自分で貼った内容は「本当にそれでいい」があり得るので確認だけ
    if (text) await assign(turn, pid, text, { guard: 'confirm' });
    return;
  }

  if (act === 'dig' || act === 'quote') {
    const sel = String(window.getSelection() || '').trim();
    if (act === 'quote' && !sel) {
      alert('掘り下げたい部分を選択してから押してください。（回答全体でよければ「深堀り」）');
      return;
    }
    const quote = act === 'quote' ? sel : turn.answers[pid].text;
    const fu = await askText('#dlg-followup', '#fu-text', {
      title: `${PROVIDER_BY_ID[pid].name} を深堀り`,
      desc: act === 'quote' ? `選択範囲: ${sel.slice(0, 60)}…` : '回答全体を踏まえて追加で聞きます。',
    });
    if (!fu) return;
    const t = newTurn(fu, { [pid]: buildQuotePrompt(quote, fu) }, [pid]);
    t.kind = `${PROVIDER_BY_ID[pid].name}を深堀り`;
    await addTurn(t);
    return;
  }

  if (act === 'cross') {
    const fu = await askText('#dlg-followup', '#fu-text', {
      title: '3社に再質問',
      desc: '全員の回答を文脈に含めて、もう一度3社に投げます。',
    });
    if (!fu) return;
    const prompt = buildCrossPrompt(turn, fu);
    const targets = activeTargets();
    const t = newTurn(fu, Object.fromEntries(targets.map((id) => [id, prompt])), targets);
    t.kind = '3社に再質問';
    await addTurn(t);
    return;
  }

  if (act === 'critique') {
    const targets = PROVIDERS
      .filter((p) => turn.answers[p.id].status === STATUS.DONE)
      .map((p) => p.id);
    const promptFor = Object.fromEntries(targets.map((id) => [id, buildCritiquePrompt(turn, id)]));
    const t = newTurn('他社の回答を読んだ上での再検討', promptFor, targets);
    t.kind = '相互レビュー';
    await addTurn(t);
  }
});

$('#btn-ask').addEventListener('click', async () => {
  const q = elQ.value.trim();
  if (!q) return;
  elQ.value = '';
  await ask(q);
});

// ---------------------------------------------------------------- 音声入力

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $('#btn-mic');
const micState = $('#mic-state');
let recog = null;

if (!SR) {
  micBtn.hidden = true;
  micState.textContent = 'キーボードのマイクで入力できます';
} else {
  micBtn.addEventListener('click', () => {
    if (recog) {
      recog.stop();
      return;
    }
    const r = new SR();
    r.lang = 'ja-JP';
    r.interimResults = true;
    r.continuous = false;
    const base = elQ.value;
    r.onresult = (ev) => {
      let text = '';
      for (const res of ev.results) text += res[0].transcript;
      elQ.value = (base ? base + ' ' : '') + text;
    };
    r.onerror = (ev) => { micState.textContent = '音声エラー: ' + ev.error; };
    r.onend = () => {
      recog = null;
      micState.textContent = '';
      micBtn.textContent = '🎤';
    };
    recog = r;
    r.start();
    micState.textContent = '聞き取り中…';
    micBtn.textContent = '⏹';
  });
}

// ---------------------------------------------------------------- テーマ

// 表示テーマだけは localStorage に置く。IndexedDB は非同期で、
// 初回描画に間に合わず一瞬別テーマが見えてしまうため。
const THEMES = [
  { key: 'auto',  label: '自動' },
  { key: 'light', label: 'ライト' },
  { key: 'dark',  label: 'ダーク' },
];

function readTheme() {
  try {
    const v = localStorage.getItem('triad-theme');
    return THEMES.some((t) => t.key === v) ? v : 'auto';
  } catch (err) {
    return 'auto';
  }
}

function applyTheme(key) {
  if (key === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = key;
  const t = THEMES.find((x) => x.key === key);
  $('#btn-theme').textContent = t ? t.label : '自動';
  try { localStorage.setItem('triad-theme', key); } catch (err) { /* 保存できなくても動く */ }
}

$('#btn-theme').addEventListener('click', () => {
  const i = THEMES.findIndex((t) => t.key === readTheme());
  applyTheme(THEMES[(i + 1) % THEMES.length].key);
});

// ---------------------------------------------------------------- 設定UI

function renderSettings() {
  const t = (settings.device && settings.device.transport) || 'auto';
  const resolved = currentTransport();
  const deviceBlock = `<div class="pset" data-device="1">
    <div class="head">この端末</div>
    <label>手動モードの送受信方式</label>
    <select data-df="transport">
      <option value="auto" ${t === 'auto' ? 'selected' : ''}>自動判定（いまは「${resolved === 'share' ? '共有シート' : 'コピー＋Webを開く'}」）</option>
      <option value="share" ${t === 'share' ? 'selected' : ''}>共有シート（Android）</option>
      <option value="copy" ${t === 'copy' ? 'selected' : ''}>コピー＋Webを開く（PC）</option>
    </select>
    <label style="display:flex;align-items:center;gap:8px;color:var(--fg);margin-top:12px">
      <input type="checkbox" data-df="autoCapture" ${settings.device.autoCapture ? 'checked' : ''}>
      戻ってきたら自動で取り込む
    </label>
    <p class="dim small" style="margin:8px 0 0">
      有効だと、相手先で回答をコピーして Triad に戻るだけでカードに入ります。
      送ったプロンプトと同じ内容は取り込みません。共有シート方式では回答は常に自動で戻ります。
    </p>
  </div>`;

  $('#settings-body').innerHTML = deviceBlock + PROVIDERS.map((p) => {
    const c = settings.providers[p.id];
    return `<div class="pset" data-p="${p.id}">
      <div class="head">
        <span class="dot" style="background:${p.color};width:9px;height:9px;border-radius:50%;display:inline-block"></span>
        ${esc(p.name)}
        <label style="margin:0 0 0 auto;color:var(--fg);font-size:13px">
          <input type="checkbox" data-f="enabled" ${c.enabled ? 'checked' : ''} style="width:auto"> 使う
        </label>
      </div>
      <label>モード</label>
      <select data-f="mode">
        <option value="share" ${c.mode === 'share' ? 'selected' : ''}>手動（アプリ / Web 経由・無料）</option>
        <option value="api" ${c.mode === 'api' ? 'selected' : ''}>API（自動・従量課金）</option>
      </select>
      <label>モデルID</label>
      <input type="text" data-f="model" value="${esc(c.model)}" placeholder="${esc(p.defaultModel)}">
      <label>APIキー<span class="dim"> — ${esc(p.keyHint)}</span></label>
      <input type="password" data-f="apiKey" value="${esc(c.apiKey)}" autocomplete="off">
    </div>`;
  }).join('');
}

$('#settings-body').addEventListener('change', async (e) => {
  const wrap = e.target.closest('.pset');
  if (!wrap) return;

  if (e.target.dataset.df) {
    settings.device[e.target.dataset.df] =
      e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    await saveSettings();
    renderSettings();
    render();
    return;
  }

  const f = e.target.dataset.f;
  if (!f) return;
  const pid = wrap.dataset.p;
  settings.providers[pid][f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  await saveSettings();
  render();
});

$('#btn-settings').addEventListener('click', () => {
  renderSettings();
  $('#dlg-settings').showModal();
});

// ---------------------------------------------------------------- 起動

async function boot() {
  applyTheme(readTheme());

  const stored = await db.get(db.STORE_KV, 'settings');
  const d = defaultSettings();
  settings = stored || d;
  // 後から増えたプロバイダ / 設定項目を埋める
  for (const id of Object.keys(d.providers)) {
    settings.providers[id] = Object.assign({}, d.providers[id], settings.providers[id] || {});
  }
  settings.device = Object.assign({}, d.device, settings.device || {});

  turns = (await db.getAll(db.STORE_TURNS)).sort((a, b) => a.createdAt - b.createdAt);
  render();

  if (currentTransport() === 'copy') {
    const w = $('#env-warn');
    w.hidden = false;
    w.textContent = settings.device.autoCapture
      ? 'この端末はコピー方式です。「開く ↗」でプロンプト入りのページが開きます。回答をコピーして Triad に戻れば自動で取り込みます。'
      : 'この端末はコピー方式です。「開く ↗」でプロンプト入りのページが開きます。回答は「クリップボードから貼る」で戻します。';
  }

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js', { type: 'module', scope: './' });
    } catch (err) {
      console.warn('SW登録失敗', err);
    }
  }

  // Share Target から戻ってきたときに付く ?inbox= を掃除
  const url = new URL(location.href);
  if (url.searchParams.has('inbox')) {
    url.searchParams.delete('inbox');
    history.replaceState(null, '', url.toString());
  }
  await processInbox();

  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = () => processInbox();
  } catch (err) {
    /* 非対応環境は visibilitychange に任せる */
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    processInbox();
    autoCapture();
  });
  window.addEventListener('focus', autoCapture);
}

boot();
