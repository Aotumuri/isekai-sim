# 通常実験の完了通知

## 初回試験

[Issue #28](https://github.com/Aotumuri/isekai-sim/issues/28) の試験では、リビジョン `51621ea` の [Issue #10 の追加診断](issue-10-peace-followthrough.md) を用いた。ジョブIDは `issue-10-peace-followthrough-51621ea`、実行上限345秒。試験用の `--acceptance-probe` を付けず、`execution.auto_resume = true` と現 Developer のスレッドを指定した `--notify-thread` で起動した。通知CLIは `/opt/homebrew/bin/codex`。起動後にチェックポイントを保存し、実験が終わる前にターンを終了した。

実験は2026年11月25日07:23:49 UTCに成功した。通常通知は1回試み、マニフェストの `notification.status` は `failed`、終了コードは1だった。`notification.log` に状態ディレクトリの SQLite `memories_1.sqlite` を開けなかったエラー（コード14）がある。同じスレッドへの続行は確認できず、`wake-receipt.json` もなかった。ログは SQLite 初期化で止まったことを示す。データベースを開けない原因や、修正後の配送成功は未確認。

人間の明示指示後に旧 Developer のターン終了を確認し、`control.py resume` で新しいスレッドに所有権を移した。既存の6出力とチェックポイントから検証を継続できた。通常通知を有効にした状態では、既定無効を前提にする停止・再開の回帰1件が失敗した。試験終了に伴い `execution.auto_resume` を既定の `false` に戻し、`python3 -m unittest discover -s agents/tools/tests -p test_framework.py` の11件が通過した。

判定は通常配送の失敗。専用環境の受け入れ試験が成功した Issue #7 と条件が異なる。次回の試験前に、通知子プロセスと手動起動したCLIで同一の状態ディレクトリを利用できるかを確認する。通常配送の再試行は保留する。証拠は `agents/runtime/jobs/issue-10-peace-followthrough-51621ea/` の `manifest.json` と `notification.log`。

## 追加調査

Issue #28 の本文と[前回のコメント](https://github.com/Aotumuri/isekai-sim/issues/28#issuecomment-7159061129)を再取得した。失敗時のマニフェストは `acceptance_probe: false`、実験終了コード 0、63.961 秒、通知試行 1 回、通知終了コード 1。引き継ぎ後の `agents/runtime/github-checkpoint.json` は Issue #10 の完了段階で元のジョブ ID を保持していた。元のジョブに wake 受領記録はない。

インストール済みの `/opt/homebrew/bin/codex` は 0.172.0。ランナーの監督プロセスは `start_new_session=True` と標準入力の切断で起動し、通知 CLI は監督の環境を継承する。実験用の `--env` は実験コマンドだけに適用される。UID 501 と同一のパスを使い、ファイルを開閉するだけの診断を行った。SQLite 接続、ファイルの作成、DB の書き込みは行っていない。

| 観測 | 通常権限相当の承認済み診断 | Codex のツールシェル | 同じシェルから切り離した子 |
| --- | --- | --- | --- |
| `HOME`、`CODEX_HOME`、`XDG_STATE_HOME` | 同じユーザーのホーム、後二者は未設定 | 同左 | 同左 |
| `CODEX_SQLITE_HOME` | `$HOME/Library/Application Support/isekai-sim/codex-sqlite` | 同左 | 同左 |
| `CODEX_SANDBOX` | 未設定 | `seatbelt` | `seatbelt` |
| `CODEX_SANDBOX_NETWORK_DISABLED` | `1`（比較コマンドに継承） | `1` | `1` |
| DB 親ディレクトリの書き込み可否 | 可 | 不可 | 不可 |
| `memories_1.sqlite` の `O_RDONLY` / `O_RDWR` | 成功 / 成功 | 成功 / `EPERM` | 成功 / `EPERM` |

対象ディレクトリは同ユーザー所有でモード 0700、DB は 0644。現在の環境で書き込み用の open を拒否する要因は実効サンドボックス制限と特定した。セッション切り離しによる UID やパスの変更は観測されなかった。CLI のローカル初期化は Queue RPC の前に状態 DB を開く。0.172.0 の実装はメモリ DB も読み書き用で開くため、読み取りが通っても初期化は失敗する。時点の異なる元ログにある SQLite コード 14 とこの実測は整合する。元の失敗時の syscall トレースと、人間が使う通常のログインシェルの環境そのものは未取得。通常権限の比較では診断側の環境変数を維持した。 [0.172.0 の CLI 初期化](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/tui/src/session_archive_commands.rs#L208) · [状態 DB の実装](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/state/src/sqlite.rs#L332)

Codex は有効な `sqlite_home`、`CODEX_SQLITE_HOME`、Codex ホームの順に SQLite の保存先を選ぶ。確認したユーザー設定とリポジトリ設定には `sqlite_home` がなく、失敗ログのパスは子プロセスの `CODEX_SQLITE_HOME` と一致する。既定の `~/.codex` にも同名 DB が存在する。通常端末で変数や設定が異なれば、手動試験が別の状態を使う可能性がある。DB のパス、スレッドを保持するサーバー、所有者 ID の一致は、通常の Developer を起動するときに確認する必要がある。 [0.172.0 の状態ディレクトリ選択](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/src/config/mod.rs#L4279)

## 配送経路と残る条件

0.172.0 の `queue --remote unix://` / `unix://PATH` は既存 app-server に Queue RPC を送る。明示接続ではクライアントの設定を検証し、サーバーが状態管理を担う。ローカルの埋め込み app-server からの `--resume` は未ロードのスレッドを起こせない。既存 TUI が待機中のスレッドを保持していれば、そのサーバーに投入した通知が次のターンを開始できる。Issue #7 では専用 DB・ソケットを使い、元の TUI が通知を消費した。 [CLI リファレンス](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-queue) · [App Server](https://learn.chatgpt.com/docs/app-server) · [0.172.0 の Queue 実装](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/tui/src/session_queue_commands.rs#L29) · [Issue #7 の実測](https://github.com/Aotumuri/isekai-sim/issues/7#issuecomment-7130886533)

親と切り離した子で `codex app-server daemon version` が既定の制御ソケットへの接続時に `EPERM` で失敗した。ワークスペース内と `/private/tmp` でも Unix ソケットの bind が `EPERM` だった。CLI のヘルプに配送機能が表示されても、通知プロセスから通常スレッドを保持するサーバーに接続できることは確認できていない。標準の同一 app-server 経路を採用するには、現在の権限で通知子から接続できるエンドポイントと、人間による同じサーバー上での Developer の手動起動が必要。[通常通知の再試験手順](../../docs/runner.md#issue-28-の通常通知)に前提と合格条件を記載した。

通常試験は起動前にブロックした。この調査スレッドの ID は保存済み Developer 所有者と異なり、実行チェックポイントと所有権は保持した。30〜60 秒のジョブ、通常配送、同一スレッドでの wake と結果の一回限りの回収は未実施。既定の `execution.auto_resume = false` と手動再開を維持する。テストのコピーで既定を true にすると旧回帰 `test_stop_drain_resume_and_stale_notification` の最初の拒否アサーションが失敗した。設定をテストごとに明示し、無効時の拒否、有効時の通常通知、graceful shutdown 専用 wake、重複拒否、手動再開を模擬 CLI で検証した。運用回帰 24 件が通過した（`cfcc8c9`）。モデル利用量は未取得。

## カスタム権限プロファイル

インストール済み CLI 0.172.0 の `codex sandbox --permission-profile NAME --include-managed-config` で、一時的な `-c` 設定を与えた。名前付きプロファイル、`extends = ":workspace"`、明示的なファイルシステム規則、`network.unix_sockets` の `allow` は設定解決を通過した。無効な親名、ファイルシステムの値、ソケットの値は設定エラーになった。有効な設定も、このセッションでは Seatbelt の二重適用時に `sandbox_apply: Operation not permitted` で停止したため、作成したプロファイルでコマンドが実行できたという実測はない。診断のソケット名には未使用のパスを指定した。 [公式 Permissions](https://learn.chatgpt.com/docs/permissions) · [0.172.0 の設定スキーマ](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/config.schema.json)

`:workspace` の継承はワークスペースと一時ディレクトリへの書き込みを継承し、`.git`、`.agents`、`.codex`、`.aws` の保護を維持できる。管理設定は引き続き上位にある。Unix ソケット許可が有効な場合、対象パスへの接続を許すが、プロファイルには RPC メソッドやスレッド ID を制限する機能がない。app-server は Queue を含むセッション操作 API を公開するので、ソケットの許可を wake 一件分の権限として扱えない。 [公式 Permissions](https://learn.chatgpt.com/docs/permissions) · [App Server](https://learn.chatgpt.com/docs/app-server)

0.172.0 の Seatbelt 実装は、ファイルシステム制限のあるプロセスに対し、共有 daemon ソケットのディレクトリへのファイルアクセスと Unix ソケットへの接続を、許可規則の後で明示的に拒否する。インストール済みバイナリにもこの拒否規則が含まれる。既定の制御ソケットはそのディレクトリ内を指す。したがって、ユーザー権限のプロファイルで既存 daemon を許可する構成は採用できない。明示的な remote Queue が SQLite を直接開かない点は確認できたが、現在の権限で利用できる配信用エンドポイントは未確認。グローバル設定、所有権、ライフサイクルとチェックポイントは保持し、通常の受け入れ試験は保留した。 [0.172.0 の Seatbelt ルール適用順](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/sandboxing/src/seatbelt.rs#L876) · [daemon の拒否規則](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/sandboxing/src/seatbelt_daemon.rs#L5)
