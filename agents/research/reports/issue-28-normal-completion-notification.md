# 通常実験の完了通知

[Issue #28](https://github.com/Aotumuri/isekai-sim/issues/28) の試験では、リビジョン `51621ea` の [Issue #10 の追加診断](issue-10-peace-followthrough.md) を用いた。ジョブIDは `issue-10-peace-followthrough-51621ea`、実行上限345秒。試験用の `--acceptance-probe` を付けず、`execution.auto_resume = true` と現 Developer のスレッドを指定した `--notify-thread` で起動した。通知CLIは `/opt/homebrew/bin/codex`。起動後にチェックポイントを保存し、実験が終わる前にターンを終了した。

実験は2026年11月25日07:23:49 UTCに成功した。通常通知は1回試み、マニフェストの `notification.status` は `failed`、終了コードは1だった。`notification.log` に状態ディレクトリの SQLite `memories_1.sqlite` を開けなかったエラー（コード14）がある。同じスレッドへの続行は確認できず、`wake-receipt.json` もなかった。ログは SQLite 初期化で止まったことを示す。データベースを開けない原因や、修正後の配送成功は未確認。

人間の明示指示後に旧 Developer のターン終了を確認し、`control.py resume` で新しいスレッドに所有権を移した。既存の6出力とチェックポイントから検証を継続できた。通常通知を有効にした状態では、既定無効を前提にする停止・再開の回帰1件が失敗した。試験終了に伴い `execution.auto_resume` を既定の `false` に戻し、`python3 -m unittest discover -s agents/tools/tests -p test_framework.py` の11件が通過した。

判定は通常配送の失敗。専用環境の受け入れ試験が成功した Issue #7 と条件が異なる。次回の試験前に、通知子プロセスと手動起動したCLIで同一の状態ディレクトリを利用できるかを確認する。通常配送の再試行は保留する。証拠は `agents/runtime/jobs/issue-10-peace-followthrough-51621ea/` の `manifest.json` と `notification.log`。
