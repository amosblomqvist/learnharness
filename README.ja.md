<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>LearnHarness Fork — 学習のためのエージェントハーネス</strong></p>

English: [README.md](README.md)

<p align="center">
  <a href="https://github.com/reeschan/learnharness/releases">ダウンロード</a> ·
  <a href="#仕組み">仕組み</a> ·
  <a href="docs/README.md">ドキュメント</a> ·
  <a href="https://github.com/reeschan/learnharness/issues">Issues</a>
</p>

LearnHarness は、AI エージェントが現在の理解度から目標までの授業を計画し、教えてくれる学習アプリです。あなたが何を理解し、どのように推論しているかを細かく記録し、学ぶにつれて更新します。

単に説明を返すだけでなく、あなたの回答や思考の記述を使って次に必要な内容を判断します。授業では推論のステップを一つずつ積み上げて理解を作り、練習で使える知識にし、知識グラフでセッションをまたいで引き継ぎます。

![LearnHarness teaching session](docs/assets/teaching-session.png)

## このフォークについて

このリポジトリは、Amos Blomqvist 氏による [LearnHarness](https://github.com/amosblomqvist/learnharness)（AGPL-3.0-only）の改変版です。デスクトップ版は、upstream 版とは別のアプリ（製品名 `LearnHarness Fork`、appId `com.reeschan.learnharness`）としてインストールされ、データの保存先（`%APPDATA%\LearnHarness Fork\data`）も分かれています。

upstream の LearnHarness に加えて、このフォークには次の機能があります。

- **コースパック**: 番号付きの章ノートを取り込み、復習の予定を組む機能
- **外部 CLI プロバイダー**: Claude Code に加えて Codex と Gemini CLI に対応
- **Explainer**: 授業内で図を中心とした HTML ページを作るサブエージェント機能
- **Fork release**: Windows x64 インストーラーのビルドと独立した自動更新

### コースパック

手元にある番号付き章フォルダ（または実行時に取得した GitHub アーカイブ）を取り込み、そのノートを使って学習と練習を行い、SM-2 で復習スケジュールを組めます。ノート本文はこのリポジトリに含まれません。詳しくは [コースパック](docs/fork/course-pack.ja.md)（English: [Course packs](docs/fork/course-pack.md)）を参照してください。

### 外部 CLI プロバイダー（Codex・Gemini CLI）

**Settings → Providers → External CLI** に、Claude Code と並んで Codex と Gemini CLI があります（どちらも既定でオフです）。事前にターミナルで CLI を入れてサインインしておくと、LearnHarness は必要なときだけ起動し（常駐プロセスは不要）、CLI 組み込みのツールを無効にして LearnHarness のツールだけを動かします。Codex は v0.165.0 以上が必要で、課金は Codex 側で行われ（`~/.codex/AGENTS.md` とスキルは読み込まれる場合があります）、モデル一覧は `codex app-server` から取得します。Gemini CLI は v0.68.0 以上が必要で、課金は Gemini CLI 側で行われ、`pro`・`flash`・`flash-lite` を使えます。

### Explainer

授業中に `explainer` サブエージェント（**Cheap** モデル枠を使用）が図を中心とした自己完結の HTML ページを作成します。サーバー側でレンダリングされ、授業のカードに縮小表示されたページを全画面で開いたり HTML としてダウンロードしたりできます。**Settings → Agent** の `Tool · explainer` でオン・オフを切り替えられます（既定はオン）。`visual-explainer` 0.15.0（MIT）を同梱しています。第三者のライセンス表記は [NOTICE](NOTICE) を参照してください。

### Fork release

版には fork version（upstream のパッチ × 100 + 通し番号。例: `0.5.0` から `0.5.1`、`0.6.1` から `0.6.101`）を使い、アプリ内の自動更新はこのフォークの GitHub Releases からのみ取得します。詳しくは [Fork のリリース](docs/fork/release.ja.md)（English: [Fork releases](docs/fork/release.md)）を参照してください。

## 仕組み

1. **測定（Measure）.** 教える前に、授業の前提となる各要素についてどこまで理解しているかを確かめます。回答・自信度・思考の記述から開始点を決めます。
2. **計画（Plan）.** 開始点から目標までの依存関係マップを作ります。計画は画面で確認でき、理解の進み方に応じて途中で組み直されます。
3. **授業（Teach）.** すでに理解していることから一歩ずつ積み上げます。予測し、説明を受け、理解を確認し、誤解があれば次に進む前に直します。見覚えがあるだけでなく、腑に落ちる状態を目指します。
4. **練習（Practice）.** 別のセッションで、解法の名前を伏せた多様な問題を出し、必要な知識を思い出して使えるようにします。問題やヒントも推論に合わせて変わります。

**考えを書き出す.** 思考欄に自分の言葉で推論・迷い・反応を書くことで、エージェントは正誤だけでなく理解の筋道を把握します。キーボード入力と音声入力を使えます。

**手元のファイルを渡す.** デスクトップアプリでは、クリップボタンやドラッグ＆ドロップで PDF や画像などのファイルを添付できます。ファイルは元の場所に残ったままパスだけが渡され、エージェントがそこから読み取ります。

エージェントはほかにも、背景での調査、図解（Visual）や図中心の Explainer ページの作成、手元の画像への矢印やラベルの書き込み、操作できるデモの作成を行えます。

## 引き継がれる知識

学んだ内容は、命題と推論の連鎖（個々の主張とそれを支える前提）として蓄積されます。知識グラフはこの構造を示し、元のセッションへ戻るリンクも持ちます。ノートを取り込むこともできます。

次からの授業では、ゼロから始める代わりにこのグラフを参照できます。練習セッションもグラフから題材を引けます。保存されるのは能力の点数ではなく、考えとつながりです。

![LearnHarness knowledge graph](docs/assets/knowledge-graph.png)

## ダウンロードと始め方

**[GitHub Releases](https://github.com/reeschan/learnharness/releases)**

- **Windows (x64):** このフォークの Releases からインストーラーをダウンロードして実行します。署名がないため、Windows で「不明な発行元」や SmartScreen の警告が出る場合があります。upstream 版の LearnHarness と並べてインストールでき、データフォルダも別です。upstream 版のデータを手で移す手順は [Move data from upstream LearnHarness](docs/fork/release.ja.md#move-data-from-upstream-learnharness) を参照してください。
- **macOS・Linux:** このフォークでは macOS と Linux 向けのインストーラーを配布していません。ソースからのビルドもこのフォークでは未確認です。

Windows 上でソースから Windows インストーラーをビルドするには、次を実行します。

```bash
npm ci
npm run desktop:dist:win
```

モデルを設定したら、理解したいテーマでセッションを始めます。プロバイダーの API キー、デスクトップアプリで対応しているサブスクリプション接続、インストール済みの外部 CLI（[Claude Code](docs/claude-code.md)・Codex・Gemini CLI）、またはローカルのモデルサーバーを含む[カスタム OpenAI 互換エンドポイント](docs/custom-providers.md)を使えます。音声入力や Web 検索には別のサービスキーを使います。Web 調査は Settings → Providers → Search で Tavily・Brave・Exa・Firecrawl・Ollama のキーを設定できます（Ollama 検索はローカルモデルではなくホストされた検索サービスを使います）。

モデル設定・音声入力・ファイル・ノートの取り込みについては [Getting started](docs/getting-started.md) を、キャッシュやコンテキスト管理については [context, caching, and costs](docs/compaction-accounting.md) を参照してください。

Windows 向けの fork ビルドは、このフォークの GitHub Releases からのアプリ内自動更新に対応しています。

## あなたのキーとデータ

- **あなたのキーとモデル.** LearnHarness 自体の課金や上乗せはありません。料金は各プロバイダー、CLI の設定、サブスクリプション、またはローカル環境に従います。画面のコスト表示は既知の API 料金のみを見積もり、サブスクリプション・CLI（`CLI billing`）・カスタムエンドポイントの料金は計算しません。
- **ローカル保存.** チャット、知識グラフ、設定、API キーはあなたのマシンに保存されます。学習記録は中身を確認できる平文ファイルです。
- **外部サービス.** モデルは設定したプロバイダー経由で実行され、タスクに必要な文脈が送信されます。Web 調査や音声入力も外部サービスへ通信します。ローカル保存はオフライン処理を意味しません。
- **確認できる挙動.** システムプロンプトは表示・編集でき、アプリは AGPL-3.0 ライセンスのオープンソースです。

## 開発とサポート

```bash
npm ci
npm run dev        # http://localhost:3000
npm test           # fixtures and fake providers
```

`npm test` は bash シェルを前提としています（Windows では Git Bash で実行してください）。

すべての案内は [documentation index](docs/README.md) を、開発環境と確認手順は [development](docs/development.md) を、ランタイム構造は [architecture](docs/architecture.md) を、ショートカットは [keyboard shortcuts](docs/keyboard.md) を、デスクトップビルドとリリースは [desktop builds and releases](docs/desktop-release.md) を参照してください。

質問・不具合報告・機能要望: [GitHub Issues](https://github.com/reeschan/learnharness/issues)

脆弱性の報告: 公開 Issue ではなく [SECURITY.md](SECURITY.md) の手順で非公開に報告してください。

## ライセンス

[AGPL-3.0](LICENSE)

upstream の [LearnHarness](https://github.com/amosblomqvist/learnharness)（[learnharness.ai](https://learnharness.ai)、[Discord](https://discord.gg/5tCHHQEB2e)）は AGPL-3.0-only のままで、著作権は Amos Blomqvist 氏にあります。このフォークはその改変版であり、AGPL-3.0-only の義務がアプリケーション全体に適用されます。

このフォークの GitHub Releases にある各リリースは、そのタグが指すコミットからビルドされています。リリースの対応するソース（Corresponding Source）は、同じタグのこのリポジトリであり、同じ Releases ページから入手できます。

取り込んだノート（`system-design-notes` など）は再配布が許諾されていないため、再配布しないでください。第三者ソフトウェア（`visual-explainer` 0.15.0、`pele`、Pi coding agent の移植）の表示は [NOTICE](NOTICE) を参照してください。
