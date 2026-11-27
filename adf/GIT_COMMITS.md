# ADF Developer のローカルコミット

## 有効化

操作者が `adf/runtime/config.toml` に次の設定を追加し、Core を再起動します。

```toml
[git]
commit = "allow"
```

既定の `commit = "deny"` では Git メタデータが読み取り専用です。`allow` では `require_commit` が既定で `true` になります。新しい研究実行の開始時に `--file` で変更対象を承認してください。調査専用でコミットを完了条件から外す場合は `require_commit = false` を設定します。進行中の研究の完了条件は研究開始時の設定を引き継ぎ、Git の書き込み権限は Core の起動時の設定を使います。

対象はチェックアウト直下に実体の `.git` ディレクトリがあるリポジトリです。ホームディレクトリの Git 設定に依存している場合は、運用前に著者の `user.name`・`user.email` と必要な hooks・署名設定をリポジトリのローカル設定に用意します。必要な hook や署名処理が権限内で動作しない場合は、失敗理由と差分・実験記録が残ります。

## 権限の範囲

`adf-commit` は許可されたチェックアウトの Developer にだけ適用されます。起動・再開・各ターンで公式の名前付き Permission Profile を指定し、対象リポジトリのインデックス・コミットメッセージ・オブジェクト・参照・reflog に書き込みを許可します。Git 設定と hooks は読み取り専用です。Coordinator は読み取り専用で、実験には別のプロファイルを使います。ADF 本体・運用 Config・SQLite・IPC・認証情報の保護、ネットワーク遮断、GitHub Issues の操作別の権限は維持されます。 [Codex Permission Profiles](https://learn.chatgpt.com/docs/permissions) · [Codex App Server](https://learn.chatgpt.com/docs/app-server)

これはパス単位の権限です。書き込み可能な参照には技術的に履歴を変更できる範囲があります。破壊的な履歴操作、Git メタデータの直接編集、push、PR 作成は `AGENTS.md` と Developer の指示で禁止します。外部への push と PR にはコマンドのネットワーク遮断と、GitHub Issues だけを扱う ADF の操作 API が適用されます。

ADF は課題開始時の HEAD を保護された実行状態に記録します。コミットオブジェクトも保全したい場合は、許可を有効にする前に操作者が、対象リポジトリの外で Developer が書き込めない場所に `git bundle create /path/outside/project/adf-before-enable.bundle HEAD` でバックアップを作成できます。課題ごとの自動バックアップは行いません。

## 完了の条件

Developer は対象ファイルを実装・検証し、自分の変更だけをステージします。作業開始時から別のステージングがあれば保全して保留します。コミット後は HEAD と含まれる変更を確認してから、Snapshot 実験を開始します。

ADF は課題開始時の HEAD を唯一の親とするスコープ付き Conventional Commit と、現在の HEAD に対応する成功実験・必須成果物を確認します。承認外の変更、変更パスに着手前の差分やステージングが含まれる場合、または承認ファイルに未コミット差分が残る場合は保留します。証拠が揃えばコミットの SHA と変更パスを記録し、次の承認済み課題に進みます。

`commit = "deny"` と `require_commit = true` を併用する場合、操作者は `python3 -m adf commit-preview` で差分を確認してコミットし、`python3 -m adf research-resume` で再開します。

## 動作確認

既存の ChatGPT ログインが使える端末で、別の使い捨てリポジトリを使って確認します。最初のコマンドは実推論を呼ばず、後者は自律コミットから次の課題までを実推論4ターンで確認します。

```sh
PYTHONPATH=.:tests/adf python3 tests/adf/live_acceptance.py --git-permissions
PYTHONPATH=.:tests/adf python3 tests/adf/live_commits.py
```

macOS の Codex App Server 0.172.0 で、4ターンを同一スレッドで実行しました。Developer が順に作成したコミットは `3ce09155e9036d81f1d6891d51ef8f1b62a9863d` と `ccf88367e1ab139a944ee5cf9ec0f02240e8ee38` です。各 HEAD の Snapshot 実験で `42` と `43` を取得し、14.14 秒と 14.85 秒の待機中に追加ターン・追加トークンは発生しませんでした。最初の評価から次の課題に追加承認なしで進み、両課題を完了しました。別の作業ファイルは変更せず、拒否モードの Git 書き込み拒否も実機で確認しました。
