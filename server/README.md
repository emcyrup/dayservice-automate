# AIリレーサーバ(Claude API接続)

かけはしノートのAI生成(報告3形態・LIFE下書き・帳票OCR・申請書類下書き)を、デモ生成から**Claude APIによる本物の生成**に切り替えるためのサーバです。

```
[ブラウザ(かけはしノート)] ── POST /ai ──▶ [このサーバ] ── Claude API ──▶ Anthropic
        APIキーを持たない                APIキーは環境変数のみ
```

**APIキーをブラウザに置かない**ための構成です。アプリ側には⚙️設定でこのサーバのURLだけを入力します。

## セットアップ

```bash
cd server
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start   # → http://localhost:8787
```

環境変数は [.env.example](.env.example) を参照(**実際のキーは .env やシークレットストアに置き、リポジトリにはコミットしない**)。

| 変数 | 必須 | 内容 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | [Anthropic Console](https://console.anthropic.com) で発行 |
| `ANTHROPIC_MODEL` | ― | 省略時 `claude-opus-5` |
| `RELAY_TOKEN` | 推奨 | 設定するとアプリからの呼び出しに `x-relay-token` ヘッダを要求(キーの無断利用を防ぐ) |
| `ALLOWED_ORIGIN` | 推奨 | CORS許可オリジン。本番は `https://emcyrup.github.io` に絞る(省略時 `*`) |
| `PORT` | ― | 省略時 8787 |

## アプリ側の設定

1. かけはしノートの **⚙️設定 → 🤖 AI接続(Claude API)** を開く
2. このサーバのURL(例: `https://ai.example.com`)を入力
3. `RELAY_TOKEN` を設定した場合はアクセストークンも入力
4. **📶 接続テスト** で疎通を確認して保存

以降の生成(📋報告・🧬LIFE下書き・📷スキャン読み取り・📑申請下書き)はClaudeが実行します。URLを空欄に戻すとデモ生成に戻ります。

## API

| エンドポイント | 内容 |
|---|---|
| `GET /health` | 疎通確認。`{ok, service, model, auth}` |
| `POST /ai` | `{app, kind, payload}` → `{ok:true, data}`。`kind`: `visit`(報告3形態) / `life`(LIFE下書き) / `ocr`(帳票読み取り・画像はbase64で受け取り**保存しない**) / `shinsei`(特定事業所加算 届出一式) |

出力はフロントのデモ生成と同じデータ形状で、構造化出力(JSON Schema)により形式を保証しています。

## デプロイの目安

Node 20+ が動く環境ならどこでも動きます(Cloud Run / Render / Railway / VPS 等)。チェックリスト:

- [ ] `ANTHROPIC_API_KEY` はデプロイ先の環境変数/シークレットに設定(コードや設定ファイルに書かない)
- [ ] `RELAY_TOKEN` を設定し、アプリの⚙️設定に同じ値を入力
- [ ] `ALLOWED_ORIGIN=https://emcyrup.github.io` に絞る
- [ ] HTTPSで公開する(Pages がHTTPSのため、HTTPのサーバへはブラウザが接続を拒否します)

## 実装メモ

- モデルは `claude-opus-5`(適応思考が既定で有効)。OCRはvision(画像入力)を使用
- システムプロンプトは全リクエストで固定し、プロンプトキャッシュを効かせる構成
- 安全システムによる生成拒否(`stop_reason: refusal`)・認証エラー・レート制限は種類別のメッセージで返し、キーやスタックトレースは返さない
- 受け取った画像はその場でClaudeに渡すのみで、サーバにもブラウザにも保存しない
- 本番では利用ログ・レート制限・監査の追加を想定(docs/AI基盤_構成方針.md 参照)
