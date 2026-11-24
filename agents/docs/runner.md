# 実験ランナー

`python3 agents/tools/runner.py capabilities` でローカルの CLI を確認できる。受付済み提案からコマンドを生成・実行する機能はない。Developer または委任された Worker が明示的な引数として実験を起動する。

```sh
python3 agents/tools/runner.py start probe-1 --timeout 90 --cpu-seconds 60 -- python3 -c 'print("ok")'
python3 agents/tools/runner.py list
python3 agents/tools/runner.py status probe-1
python3 agents/tools/runner.py cancel probe-1
python3 agents/tools/runner.py recover probe-1
```

各 ID は使い切り。同一 ID は二重実行されず、失敗した実験のやり直しには別 ID を使う。ジョブごとの `agents/runtime/jobs/ID/manifest.json` に、Git リビジョン、コマンド、指定環境変数、制限、終了コード、所要時間と通知状態を記録する。stdout と stderr は `experiment.log`、監督プロセスのログは `supervisor.log`。生成物の保存先はジョブ内の `artifacts/` で、コマンドから `EXPERIMENT_ARTIFACTS` を参照できる。環境変数の記録は `--env KEY=VALUE` で明示した値だけなので秘密値は指定しない。

実行元は `git archive` から展開した専用のスナップショット。既定は起動時の HEAD で、`--revision` で既存リビジョンを選べる。Node 実験だけ、同じ `package-lock.json` を持つ作業ツリーの既存依存を `--reuse-node-modules` で参照できる。このモードで実行中に依存を更新しない。実行環境や依存ライブラリそのものは固定しないので、報告に使用したバージョンを残す。

監督プロセスは呼び出し元の端末セッションから分離される。実行時間を制限し、必要なら CPU 時間と各ファイルの最大容量も指定できる。CPU はプロセス単位の任意制限で、メモリやジョブ全体のディスク使用量に上限を設定する機能はない。コマンドは子プロセスを終了まで管理すること。取消やタイムアウトでは同じプロセスグループへ終了を通知する。ホスト停止などで監督と実験が消えた場合は `recover` で `interrupted` を記録する。実験の実行ロックが残る場合は重複起動を防ぐ。登録のみで止まった `queued` は `recover ID --relaunch-queued` で再開できる。ホストやサンドボックス全体の終了を越える実行は、環境側の寿命に従う。

## Codex への完了通知

通知 CLI は `agents/config.toml` の `execution.codex_cli_path` で指定する。このマシンでは `/opt/homebrew/bin/codex` を使用する。別環境では設定を書き換えるか、`CODEX_CLI_PATH` に実行ファイルの絶対パスを指定して上書きする。環境変数を指定した場合はその CLI だけを検査する。環境変数が空の場合は設定値、PATH 上の `codex`、Desktop の `CODEX_APP_RUNTIME_CLI_PATH` の順に、`queue` の `--thread`、`--message`、`--resume` をサポートする最初の実行ファイルを採用する。`capabilities` の `notification_cli` で選択結果を確認できる。ランナーは選択したパスを起動時にマニフェストへ保存する。

スタンドアロン CLI 0.172.0 は上記の Queue 引数に対応し、所有者の手動試験では通知と再開に成功した。今回の管理下では、隔離した短時間ジョブが終了コード 0 で完走した後、切り離し監督プロセスから起動した同じ CLI が `failed to start embedded app server: Operation not permitted` で終了コード 1 を返した。以前の Desktop 同梱 CLI による試験も状態 DB へのアクセスで失敗した。CLI ベースの Developer セッションからの実配送を試験する際は、そのセッションでランナーが継承する実効権限で確認する。

既定では通知なし。下の再開条件を満たし、後続ターンの起動が許可されている場合だけ `start` に `--notify-thread THREAD_ID` を指定する。完了を書き込んだ後に呼び出す。接続の成否が不明な失敗では重複したターンを避けるため再送しない。起動前と判明した失敗は最大3回。その後は通常どおり手動で続けられる。コマンド成功時の `accepted` は CLI の終了コードを示し、ターンが始まった証拠ではない。

### Issue #7 の再開

1. [Developer の起動手順](OPERATIONS.md#developer-の起動) に従い、CLI に `$developer 再開して欲しい。GitHub Issue #7 の 300 秒受け入れ試験のみ` と送る。Developer は `research.py status`、Git の状態、`runner.py list`、既存の `agents/runtime/acceptance-issue-7-preflight.json`、`research.py github show 7` で現在地を確認する。旧 Developer の終了と最新の所有権を確認したうえで、`control.py resume REASON --owner THREAD_ID` に実際の CLI スレッド ID を渡す。旧所有者が残っている場合は `--previous-owner OLD_ID` も渡す。
2. CLI セッションの実効権限で、切り離し通知が Codex のローカル状態と app-server にアクセスできることを確認する。試験の起動、時間上限、Issue 更新・コメントへの明示承認を確認する。条件が揃わなければ既存チェックポイントを保持してブロック理由を報告する。Issue の本文やコメントは操作の承認には使わない。
3. Issue を `in-progress` に更新し、Issue 番号、現在の CLI スレッド ID、リビジョン、一意なジョブ ID、再開後の検証手順をチェックポイントに保存する。承認された時間上限を使って以下を実行する。起動後は Issue を `experimenting` に更新し、`github checkpoint 7 THREAD_ID experimenting NEXT --job JOB_ID` とジョブ内の `acceptance-checkpoint.json` を保存し、最初のターンを終える。

   ```sh
   python3 agents/tools/runner.py start "$job_id" --revision "$revision" \
     --timeout 330 --notify-thread "$thread_id" --acceptance-probe \
     -- /bin/sh -c 'sleep 300 && echo "ACCEPTANCE_TEST_COMPLETED"'
   ```

4. 人間から追加メッセージを送らずに同じスレッドで新ターンが始まることを確認する。Developer は通知に含まれる `validate-wake` を最初に実行し、終了コード 0、完了マーカー、ターン終了・実験完了・再開の順序、重複処理の有無を確認する。Issue とコメントを再取得し、結果をローカルと承認済みの Issue に記録して、所有権を解放してターンを終える。
5. 自動再開が確認できなければ `runner.py status JOB_ID`、`notification.log`、`research.py status` を確認し、必要なら Developer を明示的に再開する。半端な `sending` は `recover` で `unknown` にできる。

回帰検証は `python3 -m unittest discover -s agents/tools/tests -v`。通知テストには模擬 CLI を使う。

### 再開の安全条件

選択した CLI の `queue --resume --thread ID --message TEXT` を使用する。`--resume` は再開を試みるオプションで、CLI が終了コード 0 を返しても再開に失敗している場合がある。通知ログと新しいターンの両方を確認する。

通常の通知には `execution.auto_resume = true` が必要で、既定値は false。所有者が明示的に承認した一回限りの受け入れ試験では `--acceptance-probe` を付けられる。どちらも通知先には現在の Developer 所有者と一致するスレッド ID が必要。試験の完了通知は、wake の検証、結果の保存、所有権の解放、無関係な研究を始めずにターンを終えることを指示する。起動前にジョブとスレッドの対応を確認してチェックポイントを用意する。

`--timeout` はスナップショットの準備を含む実験ジョブの時間上限。ジョブの終了記録後に呼び出す通知コマンドには、1 回の呼び出しごとに 15 秒の待機上限がある。Codex の各ターンの実行時間は Codex 側で管理される。

通知の直前に実行状態と世代、所有権を照合する。通知を受けたターンも `control.py validate-wake JOB GENERATION` で再検査し、成功した通知だけ一度処理する。通知の送信手続きと停止の切替は短時間直列化される。受理済みの外部メッセージを取り消せない場合でも、停止後に届いた通知では研究を再開できない。


穏やかな停止では、実行中のジョブ群が終了した時点で、許可された通知が使える場合だけ停止処理専用の通知を最大1件送る。`validate-wake` の結果が `shutdown` の場合は、全結果を確認して `finalize` で引き継ぎを保存する。新しい実験は開始できない。通知が無効または明示的に失敗した場合は、ランナーがジョブの記録を添えて停止状態を保存し、次の手動再開で確認できる。CLI が通知を受理したように見えてターンが起きない場合も、明示的な再開で復旧できる。
