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

スタンドアロン CLI 0.172.0 は上記の Queue 引数に対応する。Issue #28 の通常実験では、実験は完走し、切り離し通知は SQLite の初期化で失敗した。現行の実効権限では同じ状態 DB の読み書き用 open と既定の app-server ソケットへの接続が拒否される。調査結果と手動端末の権限との差は[通常実験の完了通知](../research/reports/issue-28-normal-completion-notification.md)を参照。

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

### Issue #28 の通常通知

Codex 0.172.0 の macOS 版は、ファイルシステム制限のあるコマンドから既定の app-server 制御ソケットへのアクセスを強制的に拒否する。この拒否はカスタム権限プロファイルの `network.unix_sockets` やファイルシステムの許可より優先される。既定ソケットを許可リストに追加する手順は採用できない。[調査報告](../research/reports/issue-28-normal-completion-notification.md#カスタム権限プロファイル)

公式の `codex queue --remote ENDPOINT --resume --thread THREAD_ID --message TEXT` は、通知側の SQLite 初期化を省き、接続先のサーバーに状態管理を委ねる。通常運用では、管理ポリシー上で通知に使えるエンドポイントが用意され、同サーバーが Developer スレッドを保持することが前提。現時点で該当する経路は確認できていない。人間の端末からの `codex app-server daemon version` はサーバー側の確認に使える。サンドボックス内の通知経路は別途確認が必要。[Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-queue) · [Codex App Server](https://learn.chatgpt.com/docs/app-server)

通常の配送経路が使える環境で、所有者が今回限りの `auto_resume = true` を承認した後に試験する。

1. 人間が Developer を手動で起動する。Developer は古い所有者と保存済みジョブを確認し、自分のスレッド ID を登録する。実験前に一意のジョブ ID、固定リビジョン、成功時に保存する証拠と終了条件を準備する。
2. 通常の通知付きジョブを起動する。次のコマンドは約45秒の実験に60秒の上限を設定する。

   ```sh
   python3 agents/tools/runner.py start "$job_id" --revision "$revision" \
     --timeout 60 --notify-thread "$thread_id" \
     -- /bin/sh -c 'sleep 45 && echo ISSUE_28_COMPLETED'
   ```

3. `research.py github checkpoint 28 THREAD_ID experimenting NEXT --job JOB_ID` で、次の行動を wake 検証と結果の保存に限定して記録する。保存を確認したら、実験が終了する前にターンを終える。CLI を接続したままにし、人間からの追加メッセージや推論による照会を使わない。
4. 再開ターンは最初に通知内の `validate-wake` を実行する。初回ターン終了 → ジョブ完了 → 同じスレッドの新しいターンの順と、通知の投入・消費、ジョブ ID と世代、終了コード 0、完了マーカー、受領記録、結果の保存が各1回であることを照合する。CLI の終了コードや `accepted` だけでは合格にしない。証拠を保存して、そのターンを終える。
5. 試験後は一時設定を元に戻す。通常経路の合格が記録された後に既定値の変更を判断する。配送されなかった場合は、元の Developer スレッドで手動再開する。必要に応じて `runner.py status JOB_ID`、`notification.log`、保存済みチェックポイントを照合し、完了済み結果を回収する。

### 再開の安全条件

選択した CLI の `queue --resume --thread ID --message TEXT` を使用する。`--resume` は再開を試みるオプションで、CLI が終了コード 0 を返しても再開に失敗している場合がある。通知ログと新しいターンの両方を確認する。

通常の通知には `execution.auto_resume = true` が必要で、既定値は false。所有者が明示的に承認した一回限りの受け入れ試験では `--acceptance-probe` を付けられる。どちらも通知先には現在の Developer 所有者と一致するスレッド ID が必要。試験の完了通知は、wake の検証、結果の保存、所有権の解放、無関係な研究を始めずにターンを終えることを指示する。起動前にジョブとスレッドの対応を確認してチェックポイントを用意する。

`--timeout` はスナップショットの準備を含む実験ジョブの時間上限。ジョブの終了記録後に呼び出す通知コマンドには、1 回の呼び出しごとに 15 秒の待機上限がある。Codex の各ターンの実行時間は Codex 側で管理される。

通知の直前に実行状態と世代、所有権を照合する。通知を受けたターンも `control.py validate-wake JOB GENERATION` で再検査し、成功した通知だけ一度処理する。通知の送信手続きと停止の切替は短時間直列化される。受理済みの外部メッセージを取り消せない場合でも、停止後に届いた通知では研究を再開できない。


穏やかな停止では、実行中のジョブ群が終了した時点で、許可された通知が使える場合だけ停止処理専用の通知を最大1件送る。`validate-wake` の結果が `shutdown` の場合は、全結果を確認して `finalize` で引き継ぎを保存する。新しい実験は開始できない。通知が無効または明示的に失敗した場合は、ランナーがジョブの記録を添えて停止状態を保存し、次の手動再開で確認できる。CLI が通知を受理したように見えてターンが起きない場合も、明示的な再開で復旧できる。
