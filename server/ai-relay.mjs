/*
 * かけはしノート AIリレーサーバ
 *
 * ブラウザ(検証版アプリ)と Claude API の間に立つ小さなサーバ。
 * APIキーはこのサーバの環境変数にのみ置き、フロントエンドには一切出さない。
 *
 *   POST /ai      {app, kind, payload} → {ok:true, data}
 *                 kind: visit / life / keikaku / shinsei / shogu / ocr / chat
 *   GET  /health  接続テスト用
 *   GET/POST/DELETE /cases  事業所共有の事例ライブラリ(Firestore。未設定時は無効と応答)
 *
 * 起動: ANTHROPIC_API_KEY=... node ai-relay.mjs
 * 環境変数は .env.example を参照(キー名のみ。実際の値はシークレットストアで管理)
 */
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const PORT = +(process.env.PORT || 8787);
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';          // 設定すると x-relay-token 必須
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';   // 本番では Pages のオリジンに絞る

/* APIキーはリクエスト時にだけ読む。未設定のまま起動していても /health で検知できるようにする */
const hasKey = () => !!(process.env.ANTHROPIC_API_KEY || '').trim();
let _client = null;
function getClient() {
  if (!hasKey()) {
    throw Object.assign(new Error(
      'サーバにAPIキー(ANTHROPIC_API_KEY)が設定されていません。Cloud Runの「変数とシークレット」でシークレットを環境変数 ANTHROPIC_API_KEY として参照し、新しいリビジョンをデプロイしてください。'
    ), { status: 503 });
  }
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim() });
  return _client;
}

/* ---------- 出力スキーマ(フロントの demoGenerators と同じ形) ---------- */
const VisitOut = z.object({
  formal: z.string().describe('正式な訪問介護報告書。【利用者】【日時】【支援内容】【ご本人の様子】【特記事項】【担当】【支援者の体調】の見出しで整形'),
  app: z.string().describe('記録アプリ転記用の箇条書き(・時間/・支援内容/・様子/・特記/・支援者体調)'),
  summary: z.string().describe('サービス提供責任者向けの2〜3文の要約。気になる点があれば必ず言及する'),
});
const LifeOut = z.object({
  text: z.string().describe('LIFE評価の下書き所見。報告文から評価に関係する記述を箇条書きで指摘し、最後に「AIによる下書きであり判断は担当者が行う」旨を必ず添える'),
  oral: z.array(z.enum(['kobo', 'muse', 'yogore', 'gishi', 'kansou']))
    .describe('報告文から根拠をもって該当と判断した口腔項目のみ'),
});
const ShoguOut = z.object({
  note: z.string().describe('生成物の取り扱い注意(必ず確認・修正のうえ提出、区分ごとの要件数・様式は年度により異なる等)'),
  docs: z.array(z.object({ title: z.string(), text: z.string() })).length(3)
    .describe('①介護職員等処遇改善加算 計画書(基本情報) ②職場環境等要件の取組 ③賃金改善の内容と周知方法、の3文書'),
});
const KeikakuOut = z.object({
  ikou: z.string().describe('利用者・ご家族の意向。報告文から読み取れる希望・訴え・生活歴を根拠に書く。根拠がなければ「聞き取りが必要」と書き、推測で創作しない'),
  goalLong: z.string().describe('長期目標(6か月〜1年程度)。ケアプランの目標が渡されていれば必ず整合させる'),
  goalShort: z.string().describe('短期目標(1〜3か月程度)。達成を確認できる具体的な表現にする'),
  services: z.array(z.object({
    when: z.string().describe('曜日・時間帯(例: 月・水・金 9:00〜10:00)。訪問予定が渡されていればそれに合わせる'),
    kubun: z.enum(['shintai', 'seikatsu', 'both', 'joukou']).describe('サービス区分'),
    content: z.string().describe('具体的な支援内容と手順。直近の報告から「実際に行われている支援」を抽出して書く'),
  })).describe('サービス内容。渡された訪問予定と報告の実績にもとづく'),
  ryui: z.string().describe('留意事項。転倒歴・禁忌・アレルギー・その家のルール・緊急連絡など、渡された情報に含まれるもののみ'),
  note: z.string().describe('この下書きの根拠と、サービス提供責任者が本人・家族に確認すべき点を2〜3文で'),
});
const ShinseiOut = z.object({
  note: z.string().describe('生成物の取り扱い注意(必ず確認・修正のうえ提出、様式は自治体ごとに異なる等)'),
  docs: z.array(z.object({ title: z.string(), text: z.string() })).length(3)
    .describe('①介護給付費算定に係る体制等状況一覧表(抜粋) ②特定事業所加算に係る届出書 ③体制要件の整備状況の説明、の3文書'),
});
const ChatOut = z.object({
  answer: z.string().describe('相談への回答。「結論 → 根拠 → 次の一手」の順。見出し記号(#)や太字記号は使わず、短い段落と「・」の箇条書きで書く'),
  sources: z.array(z.string()).describe('回答に使った社内ライブラリの事例・制度情報のタイトル(使っていなければ空配列)'),
  followups: z.array(z.string()).max(3).describe('続けて聞くとよい質問の候補(最大3件・各30字以内)'),
});
// スキャン(OCR)は帳票種別ごとに項目が異なる
const ScanFields = {
  visit: z.object({ user: z.string(), date: z.string(), start: z.string(), end: z.string(),
    kubun: z.enum(['shintai', 'seikatsu', 'both', 'joukou']), text: z.string() }),
  vital: z.object({ user: z.string(), date: z.string(), temp: z.string(), bpH: z.string(),
    bpL: z.string(), pulse: z.string(), spo2: z.string(), weight: z.string(), text: z.string() }),
  trip: z.object({ date: z.string(), mStart: z.string(), mEnd: z.string(), min: z.string(), why: z.string() }),
  memo: z.object({ user: z.string(), date: z.string(), text: z.string() }),
};

/* ---------- プロンプト ---------- */
// システムプロンプトは全リクエストで固定し、プロンプトキャッシュを効かせる
const SYSTEM_BASE = [
  'あなたは日本の訪問介護事業所を支援するAIです。介護保険制度・訪問介護の実務に精通しています。',
  '・介護保険制度・訪問介護の実務用語(身体介護/生活援助/サービス提供責任者/特定事業所加算など)を正しく使う',
  '・事実は入力に書かれた内容のみ。推測で症状や出来事を作らない',
  '・敬体(です・ます)で、簡潔な文章にする',
  '・個人情報の追加生成(住所・実名の補完など)は行わない',
].join('\n');

const SYSTEM = [
  'あなたは日本の訪問介護事業所を支援する記録作成AIです。',
  '・介護保険制度・訪問介護の実務用語(身体介護/生活援助/サービス提供責任者/特定事業所加算など)を正しく使う',
  '・事実は入力に書かれた内容のみ。推測で症状や出来事を作らない',
  '・敬体(です・ます)で、現場でそのまま使える簡潔な文章にする',
  '・医療判断はせず、気になる兆候は「確認・共有を推奨」の形で書く',
  '・個人情報の追加生成(住所・実名の補完など)は行わない',
].join('\n');

/* 事例ブロックの整形。採用実績のある文例は「実際に提出が通った文章」として重みづけを伝える */
const caseLine = (c) => {
  const tags = [];
  if (+c.adopted > 0) tags.push(`過去に${c.adopted}回採用された実績文例`);
  if (c.shared) tags.push('事業所間で共有された事例');
  if (c.kind === 'seido') tags.push('制度情報の要約');
  return `【${c.title}${tags.length ? ' ※' + tags.join('・') : ''}】\n${c.text}`;
};
function caseBlock(p) {
  const secs = p.sections || [];
  if (secs.length) {
    return secs.map(s => [`### ${s.label} を書くときの参考`, ...(s.cases || []).map(caseLine)].join('\n')).join('\n\n');
  }
  return (p.cases || []).map(caseLine).join('\n');
}
const ADOPT_RULE = [
  '--- 参照した事例の使い方 ---',
  '・「採用された実績文例」は、この事業所が実際に提出して通った文章です。見出しの立て方・記載の粒度・語彙をできるだけ踏襲し、事業所固有の情報だけを差し替えてください。',
  '・「事業所間で共有された事例」は他事業所の書き方です。良い構成は取り入れつつ、この事業所の実態と異なる記載はそのまま写さないでください。',
  '・参照事例に無い項目を勝手に足さないでください。事実は入力された体制情報のみを使います。',
].join('\n');

function userPrompt(kind, p) {
  if (kind === 'visit') return [
    '訪問介護の報告を3形態で作成してください。',
    `利用者: ${p.userName}`, `日時: ${p.date || ''} ${p.start}〜${p.end}`,
    `ヘルパーのメモ: ${p.text}`, `担当スタッフ: ${p.staff || '(未入力)'}`, `支援者の体調: ${p.cond}`,
  ].join('\n');
  if (kind === 'life') return [
    `利用者「${p.name}」の直近の訪問報告から、LIFE(科学的介護)評価で確認すべき点を下書きしてください。`,
    '口腔項目(oral)は、報告文に明確な根拠がある項目だけを含めてください。',
    '--- 報告文 ---', ...(p.texts || []).map((t, i) => `${i + 1}. ${t}`),
  ].join('\n');
  if (kind === 'shinsei') return [
    '訪問介護の特定事業所加算の届出書類一式(3文書)を下書きしてください。',
    `事業所: 番号=${p.office?.no || '(未登録)'} 名称=${p.office?.name || '(未登録)'} 保険者番号=${p.office?.city || '(未登録)'}`,
    `算定区分の判定: ${JSON.stringify(p.kubun)}`,
    '体制要件の状況(ok=整備済):', ...(p.items || []).map(i => `・${i.n}: ${i.ok ? '整備済' : '未整備'}${i.note ? `(${i.note})` : ''}`),
    '--- 参照する過去事例・制度情報(この文体・構成を土台にする) ---',
    caseBlock(p),
    ADOPT_RULE,
    '未整備の要件は「整備を進めており届出までに完了させる」旨を明記してください。',
  ].join('\n');
  if (kind === 'shogu') return [
    '介護職員等処遇改善加算の計画書(3文書)を下書きしてください。',
    `事業所: 番号=${p.office?.no || '(未登録)'} 名称=${p.office?.name || '(未登録)'}`,
    `算定する区分: ${p.kubun || '(未選択)'} / 対象職員数: ${p.staffCount || 0}名`,
    '--- 参照する過去事例・制度情報(この文体・構成を土台にする) ---',
    caseBlock(p),
    ADOPT_RULE,
    '職場環境等要件は区分ごとに必要数が異なるため、取組の例を区分見出しつきで整理してください。',
  ].join('\n');
  if (kind === 'chat') return [
    '訪問介護事業所の職員からの相談です。次の情報を踏まえて回答してください。',
    '--- この事業所の状況(アプリに登録されている内容) ---',
    p.context || '(情報なし)',
    '--- 参照できる社内ライブラリ(事例・制度情報) ---',
    (p.cases || []).length ? (p.cases || []).map(caseLine).join('\n') : '(関連する事例は見つかりませんでした)',
    '--- 相談内容 ---',
    p.question || '',
    '回答は「結論 → 根拠 → 次の一手」の順で、現場の職員が読んで動ける具体さで書いてください。',
    '制度の細部・様式・提出期限は保険者や自治体で異なります。断定せず、確認すべき原典や窓口を必ず添えてください。',
    'ライブラリの内容を使った場合は sources にそのタイトルを入れてください。',
  ].join('\n');
  if (kind === 'keikaku') return [
    '訪問介護計画書の下書きを作成してください。サービス提供責任者が確認・修正して、利用者に説明・交付します。',
    `利用者: ${p.userName}(${p.care || '要介護度未登録'})${p.note ? ` / ${p.note}` : ''}`,
    p.cm ? `居宅介護支援事業所: ${p.cm}` : '',
    '--- 居宅サービス計画(ケアプラン)の目標 ---',
    `長期目標: ${p.cpLong || '(未入力)'}`,
    `短期目標: ${p.cpShort || '(未入力)'}`,
    '--- 訪問予定 ---',
    ...((p.plans || []).length ? (p.plans || []).map(x => `・${x}`) : ['(登録なし)']),
    '--- 直近の訪問報告(実際に行っている支援) ---',
    ...((p.reports || []).length ? (p.reports || []).map((t, i) => `${i + 1}. ${t}`) : ['(記録なし)']),
    '--- 訪問時の注意(その家のルール) ---',
    ...((p.rules || []).length ? (p.rules || []).map(x => `・${x}`) : ['(登録なし)']),
    p.prev ? `--- 前回の計画(見直しの土台) ---\n${p.prev}` : '',
    '・サービス内容は「実際に行われている支援」を報告から抽出して書き、予定にない支援を勝手に足さないでください。',
    '・目標はケアプランの目標と矛盾しないようにしてください。',
    '・医療的な判断・診断は行わず、気になる兆候は「確認・共有を推奨」の形で留意事項に書いてください。',
  ].filter(Boolean).join('\n');
  if (kind === 'ocr') return [
    `添付の手書き帳票(${p.kind})を読み取り、項目に振り分けてください。`,
    `利用者名は次の登録名から最も近いものを選ぶ: ${(p.users || []).join('、') || '(登録なし)'}`,
    '判読できない箇所は空文字にし、noteに「不鮮明のため要確認」と書いてください。',
    'note には読み取りの確度と確認してほしい箇所を1〜2文で書いてください。',
  ].join('\n');
  throw Object.assign(new Error(`unknown kind: ${kind}`), { status: 400 });
}

function outputFormat(kind, p) {
  if (kind === 'visit') return zodOutputFormat(VisitOut);
  if (kind === 'life') return zodOutputFormat(LifeOut);
  if (kind === 'shinsei') return zodOutputFormat(ShinseiOut);
  if (kind === 'shogu') return zodOutputFormat(ShoguOut);
  if (kind === 'chat') return zodOutputFormat(ChatOut);
  if (kind === 'keikaku') return zodOutputFormat(KeikakuOut);
  if (kind === 'ocr') {
    const fields = ScanFields[p.kind] || ScanFields.memo;
    return zodOutputFormat(z.object({ note: z.string(), fields }));
  }
  return null;
}

/* ---------- Claude 呼び出し ---------- */
const CHAT_SYSTEM = [
  SYSTEM_BASE,
  '',
  'あなたはいま「相談相手」として呼ばれています。相手はサービス提供責任者・管理者・訪問介護員です。',
  '・加算/減算の算定要件、届出、実績・請求、記録の書き方、LIFE、日々の運用の悩みに答える',
  '・このアプリ(CareOne)の使い方を聞かれたら、該当タブの名前を挙げて手順を案内する',
  '  タブ: 📊ダッシュボード(KPI・要対応・その場でメモ/録音)、📅予定、📋報告(3形態同時生成)、📷スキャン(手書き帳票OCR)、🚗移動、🛒買い物(金銭記録)、🧾請求(単位数計算・明細書・請求前チェック・特定事業所加算の要件チェック)、🧬LIFE、📑申請(届出書類の下書き・事例ライブラリ)、🏡利用者、⚙️設定(事業所情報・単位数マスタ・職員・バックアップ)',
  '・法令・報酬の解釈は保険者/自治体で運用が異なる。断定せず、確認先(保険者・都道府県の手引き・厚労省の通知やQ&A)を必ず添える',
  '・医療・法律の個別判断は行わず、専門職や関係機関への確認を促す',
].join('\n');

async function generate(kind, payload) {
  if (kind === 'chat') {
    const hist = (payload.history || []).slice(-8)
      .map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: String(m.text || '').slice(0, 4000) }))
      .filter(m => m.content);
    while (hist.length && hist[0].role === 'assistant') hist.shift();
    const res = await getClient().messages.parse({
      model: MODEL,
      max_tokens: 4000,
      system: [{ type: 'text', text: CHAT_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [...hist, { role: 'user', content: userPrompt('chat', payload) }],
      output_config: { format: zodOutputFormat(ChatOut) },
    });
    if (res.stop_reason === 'refusal') {
      throw Object.assign(new Error(res.stop_details?.explanation || '安全上の理由で回答できませんでした'), { status: 422 });
    }
    if (!res.parsed_output) throw Object.assign(new Error('回答の形式が不正でした。もう一度お試しください'), { status: 502 });
    return res.parsed_output;
  }
  const content = [];
  if (kind === 'ocr' && payload.image) {
    // dataURL → base64 ブロック。画像はこの場で使うだけで保存しない
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(payload.image);
    if (!m) throw Object.assign(new Error('画像の形式が不正です'), { status: 400 });
    content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  content.push({ type: 'text', text: userPrompt(kind, payload) });

  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    output_config: { format: outputFormat(kind, payload) },
  });
  if (response.stop_reason === 'refusal') {
    const why = response.stop_details?.explanation || '安全上の理由で生成できませんでした';
    throw Object.assign(new Error(why), { status: 422 });
  }
  if (!response.parsed_output) throw Object.assign(new Error('生成結果の形式が不正でした。もう一度お試しください'), { status: 502 });
  return response.parsed_output;
}

/* ---------- 事業所共有の事例ストア(Firestore・任意) ---------- */
let fsdb = null, fsTried = false, fsErr = '';
async function caseStore() {
  if (fsTried) return fsdb;
  fsTried = true;
  try {
    const { Firestore } = await import('@google-cloud/firestore');
    const db = new Firestore();
    await db.collection('cases').limit(1).get(); // 接続確認
    fsdb = db;
    console.log('shared case store: Firestore 接続OK');
  } catch (e) {
    fsErr = e.message;
    console.warn('shared case store unavailable:', e.message);
  }
  return fsdb;
}
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
function sanitizeCase(c) {
  const id = str(c.id, 64) || ('cs' + Date.now());
  if (!/^[\w-]+$/.test(id)) throw Object.assign(new Error('idの形式が不正です'), { status: 400 });
  const title = str(c.title, 200).trim(), text = str(c.text, 20000).trim();
  if (!title || !text) throw Object.assign(new Error('タイトルと本文は必須です'), { status: 400 });
  const kind = /^[a-z]{1,16}$/.test(c.kind || '') ? c.kind : '';
  const adopted = Math.max(0, Math.min(999, Math.floor(+c.adopted || 0)));
  return { id, title, text, tags: str(c.tags, 500), src: str(c.src, 1000), kind, adopted, ts: Date.now() };
}
async function handleCases(req, res, url) {
  const db = await caseStore();
  if (!db) { send(res, 503, { ok: false, error: '共有ストアが未設定です(FirestoreをGCPプロジェクトで有効化してください)。端末内のライブラリはそのまま使えます。' }); return; }
  if (req.method === 'GET') {
    const snap = await db.collection('cases').orderBy('ts').limit(500).get();
    send(res, 200, { ok: true, data: snap.docs.map(d => d.data()) });
  } else if (req.method === 'POST') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 256 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const c = sanitizeCase(JSON.parse(raw || '{}'));
        await db.collection('cases').doc(c.id).set(c);
        send(res, 200, { ok: true, data: c });
      } catch (e) { send(res, e.status || 500, { ok: false, error: e.message }); }
    });
  } else if (req.method === 'DELETE') {
    const id = url.searchParams.get('id') || '';
    if (!/^[\w-]+$/.test(id)) { send(res, 400, { ok: false, error: 'idが不正です' }); return; }
    await db.collection('cases').doc(id).delete();
    send(res, 200, { ok: true });
  } else send(res, 405, { ok: false, error: 'method not allowed' });
}

/* ---------- HTTP ---------- */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-relay-token');
}
function send(res, status, body) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    const cs = await caseStore();
    send(res, 200, { ok: true, service: 'kakehashi-ai-relay', model: MODEL, auth: RELAY_TOKEN ? 'token' : 'open', share: cs ? 'on' : 'off', key: hasKey() });
    return;
  }
  if (url.pathname === '/cases') {
    if (RELAY_TOKEN && req.headers['x-relay-token'] !== RELAY_TOKEN) {
      send(res, 401, { ok: false, error: 'アクセストークンが一致しません' }); return;
    }
    try { await handleCases(req, res, url); }
    catch (e) { send(res, 500, { ok: false, error: '共有ストアのエラー: ' + e.message }); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/ai') {
    if (RELAY_TOKEN && req.headers['x-relay-token'] !== RELAY_TOKEN) {
      send(res, 401, { ok: false, error: 'アクセストークンが一致しません' }); return;
    }
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 12 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const { kind, payload } = JSON.parse(raw || '{}');
        if (!kind) { send(res, 400, { ok: false, error: 'kind がありません' }); return; }
        const data = await generate(kind, payload || {});
        send(res, 200, { ok: true, data });
      } catch (e) {
        // 典型的なエラーを種類ごとに分けて返す(キーやスタックは返さない)
        if (e instanceof Anthropic.AuthenticationError) {
          send(res, 500, { ok: false, error: 'サーバのAPIキーが無効です(管理者に連絡してください)' });
        } else if (e instanceof Anthropic.RateLimitError) {
          send(res, 429, { ok: false, error: '混み合っています。少し待ってからお試しください' });
        } else if (e instanceof Anthropic.APIError) {
          send(res, 502, { ok: false, error: `AIサービスのエラー(${e.status})` });
        } else {
          send(res, e.status || 500, { ok: false, error: e.message || 'サーバエラー' });
        }
      }
    });
    return;
  }
  send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`kakehashi-ai-relay listening on :${PORT} (model=${MODEL}, auth=${RELAY_TOKEN ? 'token' : 'open'})`);
  if (!hasKey()) {
    console.error('ERROR: ANTHROPIC_API_KEY が未設定です。/health は応答しますが生成は 503 になります。' +
      ' Cloud Run の「変数とシークレット」でシークレットを環境変数 ANTHROPIC_API_KEY として参照してください。');
  }
});
