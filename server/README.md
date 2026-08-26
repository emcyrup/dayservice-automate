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
| `ANTHROPIC_API_KEY` | ✅ | [Anthropic Console](https://console.anthropic.com) で発行。**未設定でもサーバは起動し `/health` は応答するが、生成はすべて 503 になる**(`/health` の `key:false` で検知できる) |
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
| `GET /health` | 疎通確認。`{ok, service, model, auth, share, key}`。**`key` は `ANTHROPIC_API_KEY` が設定されているかの真偽値**(値そのものは返さない)。アプリの「接続テスト」はこれを見て、キー未設定なら警告を出す |
| `POST /ai` | `{app, kind, payload}` → `{ok:true, data}`。`kind`: `visit`(報告3形態。バイタルの測定値と前回の値も渡し、【バイタル】の記載と変化の指摘に使う) / `keikaku`(訪問介護計画書の下書き。直近の報告・訪問予定・訪問時の注意・前回の計画を渡す) / `shiji`(サ責からヘルパーへの事前指示の下書き。利用者の状態・訪問時の注意・計画書の留意事項・直近の訪問報告を渡す) / `life`(LIFE下書き) / `ocr`(帳票読み取り・画像はbase64で受け取り**保存しない**) / `shinsei`(特定事業所加算 届出一式) / `shogu`(処遇改善加算 計画書) / `chat`(AI相談。事例と事業所の集計情報を渡して回答) |

出力はフロントのデモ生成と同じデータ形状で、構造化出力(JSON Schema)により形式を保証しています。

## Cloud Run へのデプロイ(推奨)

> 🖱️ **GUI(ブラウザ)だけで構築する場合は [DEPLOY_GUI.md](DEPLOY_GUI.md) を参照。** GitHubリポジトリを直接つなぐため、構築後は `main` へのマージで自動再デプロイされます。以下はgcloud CLIでの手順です。

[Dockerfile](Dockerfile) 同梱。Cloud Run は HTTPS・自動スケール(ゼロまで)・東京リージョンが揃っており、このサーバに最適です。**キーは Secret Manager に置き、コマンドや設定ファイルには書きません。**

前提: [gcloud CLI](https://cloud.google.com/sdk/docs/install) インストール済み・`gcloud auth login` 済み・課金有効なプロジェクトがあること。

```bash
# 0) プロジェクトとリージョン(東京)を設定
gcloud config set project <YOUR_PROJECT_ID>
gcloud config set run/region asia-northeast1

# 1) 必要なAPIを有効化
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com

# 2) シークレット登録(値は対話入力。シェル履歴に残さない)
#    APIキーは https://console.anthropic.com で発行したもの
printf "Anthropic APIキーを入力: " && read -rs KEY && printf '%s' "$KEY" | \
  gcloud secrets create anthropic-api-key --data-file=- && unset KEY
#    アプリと共有するアクセストークン(ランダム生成)
openssl rand -hex 24 | tee /dev/tty | tr -d '\n' | \
  gcloud secrets create kakehashi-relay-token --data-file=-
#    ↑ 表示された値をBitwardenに保管し、アプリの⚙️設定にも入力する

# 3) デプロイ(server/ ディレクトリで実行。ソースから自動ビルド)
cd server
gcloud run deploy kakehashi-ai-relay \
  --source . \
  --allow-unauthenticated \
  --set-secrets "ANTHROPIC_API_KEY=anthropic-api-key:latest,RELAY_TOKEN=kakehashi-relay-token:latest" \
  --set-env-vars "ALLOWED_ORIGIN=https://emcyrup.github.io" \
  --memory 512Mi --cpu 1 --min-instances 0 --max-instances 3 \
  --timeout 300

# 4) 発行されたURL(https://kakehashi-ai-relay-....run.app)を確認
curl https://<発行されたURL>/health
```

最後に、かけはしノートの **⚙️設定 → 🤖 AI接続** に発行されたURLと `kakehashi-relay-token` の値を入力し、📶接続テスト → 保存で完了です。

補足:

- `--allow-unauthenticated` はCloud Run層の認証を外す設定です。実際のアクセス制御は `RELAY_TOKEN`(＋CORS)で行います
- 初回デプロイ時に「Artifact Registryリポジトリを作成しますか?」と聞かれたら Y
- 費用: min-instances 0 なので**リクエストがない間は0円**。検証規模ならCloud Run代は無料枠内が目安(AI利用料は別途・docs/接続情報.md参照)
- 更新時は同じ `gcloud run deploy` を再実行するだけ
- ログ確認: `gcloud run services logs read kakehashi-ai-relay`

## 事例ライブラリの事業所共有(Firestore・任意)

📑申請アシスタントの事例ライブラリを**事業所内の全端末で共有**できます。有効化しない場合は従来どおり端末内保存で動作します。

**GUIでの有効化(5分)**:

1. Google Cloud Console の検索バーで **「Firestore」** を開く → **「データベースを作成」**
2. モード: **ネイティブ モード** / ロケーション: **asia-northeast1(東京)** → 作成
3. 以上。リレーサーバが起動時に自動検出します(Cloud Runの実行サービスアカウントに既定の権限があれば追加設定不要。権限エラーが出る場合は IAM で実行SAに **Cloud Datastore ユーザー** ロールを付与)
4. 確認: `https://<サーバURL>/health` の応答が `"share":"on"` になればOK。アプリの📚事例ライブラリに「🌐 事業所で共有中」と表示されます

- 保存されるのは事例(タイトル・タグ・本文・出典URL)のみ。**利用者の個人情報は保存しない運用**を画面に明記済み
- API: `GET/POST/DELETE /cases`(RELAY_TOKEN 必須)。1件20,000字・最大500件

## その他の環境へのデプロイ

Node 20+ が動く環境ならどこでも動きます(Render / Railway / VPS 等)。チェックリスト:

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
