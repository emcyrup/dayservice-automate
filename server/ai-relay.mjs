/*
 * かけはしノート AIリレーサーバ
 *
 * ブラウザ(検証版アプリ)と Claude API の間に立つ小さなサーバ。
 * APIキーはこのサーバの環境変数にのみ置き、フロントエンドには一切出さない。
 *
 *   POST /ai      {app, kind, payload} → {ok:true, data}
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

const client = new Anthropic(); // ANTHROPIC_API_KEY を環境変数から読む

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
const ShinseiOut = z.object({
  note: z.string().describe('生成物の取り扱い注意(必ず確認・修正のうえ提出、様式は自治体ごとに異なる等)'),
  docs: z.array(z.object({ title: z.string(), text: z.string() })).length(3)
    .describe('①介護給付費算定に係る体制等状況一覧表(抜粋) ②特定事業所加算に係る届出書 ③体制要件の整備状況の説明、の3文書'),
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
const SYSTEM = [
  'あなたは日本の訪問介護事業所を支援する記録作成AIです。',
  '・介護保険制度・訪問介護の実務用語(身体介護/生活援助/サービス提供責任者/特定事業所加算など)を正しく使う',
  '・事実は入力に書かれた内容のみ。推測で症状や出来事を作らない',
  '・敬体(です・ます)で、現場でそのまま使える簡潔な文章にする',
  '・医療判断はせず、気になる兆候は「確認・共有を推奨」の形で書く',
  '・個人情報の追加生成(住所・実名の補完など)は行わない',
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
    ...(p.cases || []).map(c => `【${c.title}】${c.text}`),
    '未整備の要件は「整備を進めており届出までに完了させる」旨を明記してください。',
  ].join('\n');
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
  if (kind === 'ocr') {
    const fields = ScanFields[p.kind] || ScanFields.memo;
    return zodOutputFormat(z.object({ note: z.string(), fields }));
  }
  return null;
}

/* ---------- Claude 呼び出し ---------- */
async function generate(kind, payload) {
  const content = [];
  if (kind === 'ocr' && payload.image) {
    // dataURL → base64 ブロック。画像はこの場で使うだけで保存しない
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(payload.image);
    if (!m) throw Object.assign(new Error('画像の形式が不正です'), { status: 400 });
    content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  content.push({ type: 'text', text: userPrompt(kind, payload) });

  const response = await client.messages.parse({
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
  return { id, title, text, tags: str(c.tags, 500), src: str(c.src, 1000), ts: Date.now() };
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
    send(res, 200, { ok: true, service: 'kakehashi-ai-relay', model: MODEL, auth: RELAY_TOKEN ? 'token' : 'open', share: cs ? 'on' : 'off' });
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
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('warning: ANTHROPIC_API_KEY が未設定です(ant auth のプロファイルがあればそれを使用します)');
  }
});
