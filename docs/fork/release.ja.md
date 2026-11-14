# Fork のリリース

[English](release.md)

## Fork version

fork のパッチ番号は、upstream のパッチ番号 × 100 に、1〜99 の通し番号を足します。`npx tsx scripts/fork-version.ts <upstream> <n>` で計算できます。upstream の新しい版を取り込んだら通し番号を 1 に戻します。`x.y.0` の上では `x.y.1` から始まります。例えば `0.5.0` と 1 は `0.5.1`、`0.6.1` と 1 は `0.6.101` です。

## Release

最初のタグの前に、fork の Actions タブで Actions を有効にします。Settings → Actions → General → Workflow permissions を確認します。fork の既定は read で、必要な job は `permissions: contents: write` を要求します。`release.yml` の `workflow_dispatch` を一度実行して Windows のリハーサルを行います。リリースは公開されません。

1. `npm version <version> --no-git-tag-version` で両方の package ファイルの版を更新し、変更をコミットします。
2. `git tag v<version>` でタグを作り、コミットを `origin` に push してから、`git push origin v<version>` でそのタグだけを push します。このクローンには upstream のタグもあるため、`git push --tags` は使いません。
3. Actions は quality → draft → Windows package → verify（インストーラー、blockmap、`latest.yml`）→ publish の順に実行されます。成功すると自動で公開されます。

後の検査が失敗した場合、下書きは公開されずに残ります。実行結果と下書きを確認してください。一時的な失敗ならワークフローを再実行します。既存の下書きを再利用するので、必要なら古いアセットや重複を削除します。タグのコードを修正する場合は下書きとタグを破棄し、修正をコミットして新しい版とタグを作ります。破棄するには GitHub で下書きリリースを削除し、リモートのタグを `git push origin --delete v<version>`、ローカルのタグを `git tag -d v<version>` で削除します。公開済みリリースは draft job が拒否するため、下書きとして再利用できません。

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
