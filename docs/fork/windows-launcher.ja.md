# Windows の起動ショートカット

[English](windows-launcher.md)

`main` の最新を、インストーラーを作らずに使うためのショートカットです。起動のたびに `origin/main` に追従し、コミットが変わったときだけビルドし直します。

- **LearnHarness Fork**: [Pake](https://github.com/tw93/Pake) で作った軽い窓 (WebView2) で開きます。窓を閉じるとサーバーも止まります。
- **LearnHarness Fork (Web)**: 既定のブラウザーで開きます。サーバーは最小化したコンソールで動き、その窓を閉じると止まります。

どちらも同じサーバー (`http://127.0.0.1:3010`) を使います。片方がサーバーを動かしている間は、もう片方は更新せずにそのサーバーを開きます。サーバーを止めるのは、それを起動した側だけです。

## 前提

- Node.js と git
- Pake の窓を作るための Rust 1.85 以上と、Visual Studio Build Tools (「C++ によるデスクトップ開発」)。WebView2 は Windows 11 に入っています

## セットアップ

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
```

`setup.ps1` は次のことをします。

1. `%USERPROFILE%\apps\learnharness` に `origin/main` を clone します (`-AppDir` で場所を変えられます)。
2. `pake-cli` が無ければ `npm install -g` で入れ、`%LOCALAPPDATA%\LearnHarness Fork Launcher\LearnHarnessFork.exe` を作ります。初回の Rust のビルドには数分かかります。
3. デスクトップとスタートメニューに 2 つのショートカットを作ります。ショートカットは clone の中の `scripts\windows` を実行するので、pull すると起動スクリプトも新しくなります。

最初の起動では `npm ci` と `next build` が走るため、数分かかります。

## 起動のたびの更新

1. `git fetch origin main` のあと、`git merge --ff-only` で進めます。オフラインのとき、clone が `main` 以外のブランチのとき、追跡しているファイルに変更があるときは、更新を飛ばして今のビルドで起動します。
2. `package-lock.json` (プラグインのものを含む) が変わったときだけ、`npm ci` と `npm run plugins:setup` を実行します。
3. HEAD が前回のビルドと違うときだけ、`npm run build` と `node scripts/build-server.mjs` を実行します。ビルドの標準入力は空にするので、`next build` が出す「Next.js を更新するか」のメニューは出ません (メニューで更新すると clone の `package.json` が変わり、追従が止まるためです)。ビルドが書き換える `next-env.d.ts` は、次の更新の前に元に戻します。
4. `.next/standalone/server.js` を `127.0.0.1:3010` で起動します。

## データ

学習データと API キーは、配布版のアプリと同じ `%APPDATA%\LearnHarness Fork\data` と `%APPDATA%\LearnHarness Fork\auth.json` に置きます。clone を作り直しても消えません。後でインストーラー版を入れても同じデータを使います。同時に動かすと 2 つのサーバーが同じデータを読み書きするので、どちらか一方だけを動かしてください。

## 制限

- Pake の窓とブラウザーは Web 版として動きます。デスクトップアプリだけの機能 (添付したファイルをパスのまま渡す機能や、サブスクリプションのログインなど) は使えません。
- ポートを変えるときは、`setup.ps1 -Port <番号> -RebuildPake` を実行して、窓とショートカットを作り直します。3000〜3005 は開発用なので避けてください。
