# Fork のリリース

[English](release.md)

## Fork version

fork のパッチ番号は、upstream のパッチ番号 × 100 に、1〜99 の通し番号を足します。`npx tsx scripts/fork-version.ts <upstream> <n>` で計算できます。upstream の新しい版を取り込んだら通し番号を 1 に戻します。`x.y.0` の上では `x.y.1` から始まります。例えば `0.5.0` と 1 は `0.5.1`、`0.6.1` と 1 は `0.6.101` です。

## Release

最初のタグの前に、fork の Actions タブで Actions を有効にします。Settings → Actions → General → Workflow permissions を確認します。fork の既定は read で、必要な job は `permissions: contents: write` を要求します。`release.yml` の `workflow_dispatch` を一度実行して Windows のリハーサルを行います。リリースは公開されません。

1. プルリクエストの中で、`npm version <version> --no-git-tag-version` を使って両方の package ファイルの版を上げ、変更をコミットします。
2. プルリクエストを `main` にマージします。タグを自分で作ったり push したりする必要はありません。
3. Actions は decide → quality → draft → Windows package → verify（インストーラー、blockmap、`latest.yml`）→ publish の順に実行されます。quality job は最初に版番号が上の fork version の規則に合っているかを確かめます。検査が通ると、draft job がマージしたコミットに `v<version>` のタグを付けます。成功すると自動で公開されます。

版を上げないマージでは何も公開しません。decide job が `v<version>` は公開済みだと判断し、残りの job を飛ばします。`v<version>` のタグが別のコミットにあり、まだ公開されていない場合は、実行が失敗します。版を上げるか、下の手順でそのタグと下書きを破棄してください。これまでどおり、`v<version>` のタグを手で push してもリリースが始まります。

後の検査が失敗した場合、下書きは公開されずに残ります。実行結果と下書きを確認してください。一時的な失敗ならワークフローを再実行します。既存のタグと下書きを再利用するので、必要なら古いアセットや重複を削除します。タグのコードを修正する場合は下書きとタグを破棄し、修正をコミットして新しい版とタグを作ります。破棄するには GitHub で下書きリリースを削除し、リモートのタグを `git push origin --delete v<version>`、ローカルのタグを `git tag -d v<version>` で削除します。公開済みリリースは draft job が拒否するため、下書きとして再利用できません。

## Local build

Windows 上で `npm run desktop:dist:win` を実行します。出力は `dist/LearnHarness Fork-<version>-x64-setup.exe` です。Releases の名前では空白がハイフンになります。署名がないため SmartScreen が警告する場合があります。

## Auto-update

fork は [reeschan/learnharness の Releases](https://github.com/reeschan/learnharness/releases) からのみ更新します。更新にはリポジトリが公開されている必要があります。

## Move data from upstream LearnHarness

fork は空のデータから始まり、upstream のデータは自動で移しません。

1. 両方のアプリを閉じます。
2. `%APPDATA%\LearnHarness\data` を `%APPDATA%\LearnHarness Fork\data` にコピーします。コピー先にある fork のデータは上書きされる場合があります。Windows のコマンドプロンプトでの例:

   ```bat
   robocopy "%APPDATA%\LearnHarness\data" "%APPDATA%\LearnHarness Fork\data" /E
   ```

3. fork を開いてコピーしたデータを確認します。`data` の横の認証ファイルを移すかは別に選んでください。対象は `auth.json`（API キー）、`chatgpt-credentials.json`、`github-copilot-credentials.json`、`xai-credentials.json` です。機密情報を含むため、他人に渡さないでください。`logs` と Electron の内部フォルダはコピーしません。
