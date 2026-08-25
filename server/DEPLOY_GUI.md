# Cloud Run 構築手順(GUIのみ・gcloud不要)

Google Cloud Console(ブラウザ)だけでAIリレーサーバを構築する手順です。
GitHubリポジトリを直接つなぐため、**構築後は `main` にマージするだけで自動再デプロイ**されます。

所要時間の目安: 20〜30分(初回のGCPプロジェクト作成を含む)

---

## 0. 事前に用意するもの

| もの | 入手先 |
|---|---|
| Googleアカウント+課金有効なGCPプロジェクト | [console.cloud.google.com](https://console.cloud.google.com) → 上部のプロジェクト選択 → 「新しいプロジェクト」 |
| Anthropic APIキー | [console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key。**発行したらBitwardenに保管** |
| アプリ用アクセストークン(任意の長いランダム文字列) | Bitwardenのパスワード生成機能で32文字以上を生成し、そのままBitwardenに保管 |

## 1. シークレットの登録(Secret Manager)

1. Consoleの検索バーで **「Secret Manager」** を検索して開く(初回は「APIを有効にする」を押す)
2. **「＋シークレットを作成」** で以下の2つを作成:

| 名前 | シークレットの値 |
|---|---|
| `anthropic-api-key` | AnthropicのAPIキー(`sk-ant-…`) |
| `kakehashi-relay-token` | 生成したアクセストークン |

他の項目は既定のままで「シークレットを作成」。

## 2. Cloud Run サービスの作成

1. 検索バーで **「Cloud Run」** を開く → **「サービスをデプロイ」**(または「＋サービスの作成」)
2. **「リポジトリから継続的にデプロイする(ソースまたは関数をデプロイする)」** を選び、**「CLOUD BUILD の設定」** を押す
   - プロバイダ: **GitHub** → 認証してリポジトリ **`emcyrup/dayservice-automate`** を接続(初回は「Google Cloud Build」GitHubアプリのインストールを求められる)
   - ブランチ: `^main$`
   - ビルドタイプ: **Dockerfile**
   - ソースの場所: **`/server/Dockerfile`**
   - 「保存」
3. サービスの設定:

| 項目 | 値 |
|---|---|
| サービス名 | `kakehashi-ai-relay` |
| リージョン | **asia-northeast1(東京)** |
| 認証 | **未認証の呼び出しを許可**(アクセス制御はRELAY_TOKENで行う) |
| 課金 | リクエストベース |
| 自動スケーリング | 最小 **0** / 最大 **3** |
| 上り(内向き) | すべて |

4. 下部の **「コンテナ、ボリューム、ネットワーキング、セキュリティ」** を開いて設定:
   - **リソース**: メモリ **512 MiB** / CPU **1**
   - **リクエスト タイムアウト**: **300** 秒
   - **「変数とシークレット」タブ**:
     - 環境変数を追加: 名前 `ALLOWED_ORIGIN` / 値 `https://emcyrup.github.io`
     - **「シークレットを参照」** で2つ追加:
       - シークレット `anthropic-api-key` → 参照方法 **環境変数として公開** → 名前 **`ANTHROPIC_API_KEY`** → バージョン latest
       - シークレット `kakehashi-relay-token` → 環境変数 **`RELAY_TOKEN`** → latest
     - ⚠️ ここで「(サービスアカウント)に権限を付与」と表示されたら **「付与」を押す**(Secret Managerの読み取り権限)
     - ⚠️ **参照方法は必ず「環境変数として公開」**を選ぶこと。「ボリュームとしてマウント」を選ぶと環境変数にはならず、生成のたびに認証エラーになります
5. **「作成」** → 初回ビルドが走る(2〜5分)。完了するとサービスに **`https://kakehashi-ai-relay-….run.app`** のURLが表示される

## 3. 動作確認

ブラウザで `https://<表示されたURL>/health` を開き、次のようなJSONが出ればOK:

```json
{"ok":true,"service":"kakehashi-ai-relay","model":"claude-opus-5","auth":"token","share":"on","key":true}
```

- `key` が **`false`** の場合は `ANTHROPIC_API_KEY` がリビジョンに渡っていません。**サーバは起動しますが、生成のたびに失敗します**(手順2-4を確認)
- `auth` が `"open"` の場合は `RELAY_TOKEN` が設定されていません(手順2-4を確認)
- `share` が `"off"` の場合は Firestore が未設定です(事例の事業所共有だけが無効。他の機能には影響しません)

## 4. アプリ側の設定

1. かけはしノート → **⚙️設定 → 🤖 AI接続(Claude API)**
2. AIサーバURLに Cloud Run のURL、アクセストークンに `kakehashi-relay-token` の値を入力
3. **📶 接続テスト** → ✅が出たら **保存**

以降、📋報告・🧬LIFE下書き・📷スキャン読み取り・📑申請下書きがClaudeで生成されます。

## 5. 運用メモ

- **更新**: `server/` を変更して `main` にマージすると自動で再ビルド・デプロイされます
- **アプリ側だけの変更でもビルドが走るのを止めたい場合**: Cloud Build → トリガー → 該当トリガーを編集 → 「含まれるファイルフィルタ」に `server/**` を追加
- **ログ**: Cloud Run → サービス → 「ログ」タブ
- **費用**: 最小インスタンス0のため、リクエストがない間のCloud Run課金は0円。AI利用料は別途(docs/接続情報.md のコスト目安参照)
- **キーのローテーション**: Secret Managerで新しいバージョンを追加 → Cloud Runで「新しいリビジョンの編集とデプロイ」を1回実行(latest参照のため値の差し替えだけで反映)

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| ビルド失敗: `package.json not found` | ビルドコンテキストがリポジトリ直下になっている。Cloud Build → トリガー → 編集で、Dockerfileのディレクトリ/ソースの場所が `/server/` 配下を指しているか確認 |
| デプロイ失敗: シークレットへのアクセス拒否(PERMISSION_DENIED) | IAM → Compute Engine デフォルトSA(`…-compute@developer.gserviceaccount.com`)に **Secret Manager のシークレット アクセサー** ロールを付与 |
| 接続テストで ❌(CORS) | `ALLOWED_ORIGIN` の値が `https://emcyrup.github.io` (末尾スラッシュなし)か確認 |
| 401 が返る | アプリ⚙️設定のトークンと `kakehashi-relay-token` の値が一致しているか確認 |
| 生成時に **`Could not resolve authentication method`** / 「サーバにAPIキーが設定されていません」 | `ANTHROPIC_API_KEY` がリビジョンに渡っていない。Cloud Run → サービス →「新しいリビジョンの編集とデプロイ」→「変数とシークレット」で、`anthropic-api-key` が **環境変数 `ANTHROPIC_API_KEY` として公開**されているか確認(ボリュームマウントでは環境変数にならない)。直したら**デプロイし直す**(既存リビジョンには反映されない)。`/health` の `key` が `true` になれば解決 |
| `/health` は成功するのに生成だけ失敗する | `/health` はClaudeを呼ばないため、APIキーがなくても成功する。`key:false` を確認すること(古いリビジョンでは `key` 自体が返らない) |
