# Git コミットの権限と完了条件

## 実効権限

ADF は Developer の起動時・再開時・各ターンに `adf-writer` を指定します。プロファイルは作業ツリーに書き込みを許可し、`.git` を明示的に読み取り専用にします。Coordinator には `adf-reader` を指定します。両ロールともコマンドのネットワーク接続を無効にし、`approvalPolicy = never` を使います。Core はコマンド・ファイル変更の承認要求を拒否します。

Codex の既定 `workspace-write` にも `.git` の保護があります。名前付き Permission Profile では明示的な上書きが可能です。管理者のプロファイル許可リストや親プロセスの OS サンドボックスは別の制約です。実際に起動した App Server の管理要件は `configRequirements/read`、スレッドに選択されたプロファイルは `thread/start` の `activePermissionProfile` で確認できます。最終的な書き込み可否は同じプロファイルでコマンドを実行して確かめます。[Permission Profiles](https://learn.chatgpt.com/docs/permissions) · [既定の保護パス](https://learn.chatgpt.com/docs/agent-approvals-security#protected-paths-in-writable-roots) · [App Server](https://learn.chatgpt.com/docs/app-server)

Codex 0.172.0 の macOS で、実 App Server の `adf-writer` はファイル編集・その内容の確認・`git status`・`git diff` を許可し、`git add` と `git commit` を `.git/index.lock` の作成時に拒否しました。使い捨てリポジトリで `.git` だけを `write` にした比較プロファイルでは、`git add` と `git commit` が終了コード 0 になり、HEAD が `e60c65bea5144fc8e33aee9baedd16151620cdc5` から `f78bc4e5f027e7506a03ec23fd93d02097a79952` に進みました。コミットの変更パスは `example.txt` のみでした。同じ権限で `git update-ref` も終了コード 0 となり、HEAD を元に戻せました。この比較プロファイルは本番の選択肢に含めていません。

本番プロファイルで ADF 本体・設定・SQLite・IPC の保護と、作業領域外の使い捨てリモートへの push の拒否を確認しました。テスト担当者が作成したコミット `abbfab7e75f32b99ebce424c6a1dc9b2e1ecd887` を使い、実 App Server の実験プロファイルでスナップショットを実行して `fixture.txt=42` を観測しました。別の実推論試験は2ターンで、約33秒の実験待機中の追加ターン・追加トークンはともに0でした。実験後の継続、App Server 再起動後の復元ともに同じスレッドで行われました。

Codex の `prefix_rule` はコマンドの先頭引数を照合し、`allow` は一致したコマンドをサンドボックス外で実行します。`prompt` と `forbidden` も、照合できた呼び出しに適用されます。任意のスクリプトによる直接の Git メタデータ変更はファイル権限の範囲です。App Server には追加権限をコマンド単位で申請する実験的な機能があります。承認通知はコマンド文字列と表示用の解析結果を含みます。ADF はそれを基にした自動承認を有効にしていません。登録済みリポジトリのコミット操作だけに限定し、履歴書き換えを強制的に拒否できる運用は、今回の検証では確立できませんでした。[コマンドルール](https://learn.chatgpt.com/docs/agent-configuration/rules) · [App Server の承認](https://learn.chatgpt.com/docs/app-server#approvals)

実効的な境界は、登録リポジトリの Git メタデータの書き込み拒否、サンドボックス外のリモートへのファイルアクセス拒否、コマンドのネットワーク遮断、GitHub Issues に限定した操作 API です。push・PR を避けるロール指示も維持しています。任意の書き込み可能ディレクトリに作った別の Git リポジトリまで対象とする、Git サブコマンド単位の拒否ではありません。

## 設定と手動コミットからの再開

コミットが必要な研究では、運用 Config の `adf/runtime/config.toml` に以下を設定し、Core を再起動して新しい研究実行を開始します。承認範囲には各課題の対象ファイルを指定します。

```toml
[git]
require_commit = true
commit = "deny"
push = "deny"
pull_request = "deny"
destructive_history_operations = "deny"
```

4つの操作の既定は `deny` です。`allow` と `ask` は現行の管理ロールで強制できる仕組みがないため、設定の検証時に拒否します。`require_commit` の既定は `false` です。新しい研究実行に設定を保存し、再開時も同じ完了条件を使います。

1. Developer が実装と事前検証を行います。必要なコミットがなければ課題は保留され、変更と実験記録が残ります。
2. 人間が `python3 -m adf commit-preview` と通常の Git で差分・既存ステージング・試験結果を確認します。承認済みのファイルだけを、既存の hooks を有効にしたまま、スコープ付きの Conventional Commit でコミットします。Git 管理外の Config、SQLite、ログ、認証情報は対象から外します。
3. `python3 -m adf research-resume` で再開し、新しい HEAD を元に実験を実行します。以前の HEAD で取得した実験結果は完了の証拠から外れます。
4. ADF は開始時 HEAD を唯一の親に持つ新しいコミットを検証します。承認外の変更、着手前から差分またはステージングのあった変更パス、承認ファイルの未コミット差分があれば保留します。現在の HEAD と一致する成功実験・必須成果物を確認し、コミットの SHA と変更パスを研究結果に記録します。

実 App Server で既存の保護、Git の拒否、手動コミットからのスナップショット実行を確認するには、既存の ChatGPT ログインが使える端末で次を実行します。使い捨てリポジトリを使い、推論ターンは開始しません。

```sh
PYTHONPATH=.:tests/adf python3 tests/adf/live_acceptance.py --git-permissions
```
