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

| 機能 | この環境で確認した範囲 |
| --- | --- |
| ChatGPT アプリ同梱 CLI 0.171.0-alpha.13.2 | `queue --thread --message`、`exec resume` と `app-server` のヘルプあり。実試験では状態 DB が開けず、通知と自動再開は失敗。 |
| PATH の CLI 0.143.0 | `exec resume` と `app-server` のヘルプあり。`queue` 専用ヘルプなし。 |
| スレッド識別 | アプリ実行環境に `CODEX_THREAD_ID` あり。実試験ではローカル DB が開けず、配送先は未確認。 |
| Codex SDK、app-server | 公式にはスレッド作成、再開、ターン開始の方法がある。現環境の CLI はローカル状態 DB を開けなかった。自動の新規スレッド作成は設定していない。 |
| バックグラウンド | `tmux` は見つからず。独立プロセスが起動コマンド終了後も継続し、実際の燃料実験が完走。実試験のジョブはエージェントのターン終了後も完走。 |

[SDK](https://developers.openai.com/codex/sdk) · [app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

既定では通知なし。下の再開条件を満たし、後続ターンの起動が許可されている場合だけ `start` に `--notify-thread THREAD_ID` を指定する。完了を書き込んだ後に呼び出す。接続の成否が不明な失敗では重複したターンを避けるため再送しない。起動前と判明した失敗は最大3回。その後は通常どおり手動で続けられる。コマンド成功時の `accepted` は CLI の終了コードを示し、ターンが始まった証拠ではない。

自動再開の残りの受け入れ手順は以下のとおり。

1. 書き込み可能な、起動が許可された Codex セッションと、そのスレッド ID を明示する。対象は事前に使える同梱 CLI で確認する。
2. Developer が60秒程度の診断コマンドを一意なジョブ ID、120秒以下の時間上限、`--notify-thread THREAD_ID --acceptance-probe` 付きで起動し、チェックポイントに ID を保存して直ちにターンを終える。
3. 人間から追加メッセージを送らず、終了記録の後に**同じスレッド**で新ターンが開始し、Developer が該当ジョブの結果を取得したことを確認する。二重通知や同じ完了タスクの重複処理がなかったことも確認する。
4. 確認できなければ `runner.py status ID` と `research.py status` を保存し、新しいターンで Developer を手動再開する。半端な `sending` は `recover` で `unknown` にできる。

回帰検証は `python3 -m unittest discover -s agents/tools/tests -v`。通知テストには模擬 CLI を使う。

### 再開の安全条件

同梱 CLI の `queue --resume --thread ID --message TEXT` を使用する。`--resume` は再開を試みるオプションで、CLI が終了コード0を返しても再開に失敗している場合がある。通知ログと新しいターンの両方を確認する。

通常の通知には `execution.auto_resume = true` と、現在の Developer 所有者に一致するスレッド ID が必要。既定値は false。所有者の指示で行う一回限りの受け入れ試験では `--acceptance-probe` を付けられる。120秒以下に制限され、通知本文は検証結果の保存とターン終了だけを指示する。起動前にジョブとスレッドの対応を確認してチェックポイントを用意する。

通知の直前に実行状態と世代、所有権を照合する。通知を受けたターンも `control.py validate-wake JOB GENERATION` で再検査し、成功した通知だけ一度処理する。通知の送信手続きと停止の切替は短時間直列化される。受理済みの外部メッセージを取り消せない場合でも、停止後に届いた通知では研究を再開できない。


穏やかな停止では、実行中のジョブ群が終了した時点で、許可された通知が使える場合だけ停止処理専用の通知を最大1件送る。`validate-wake` の結果が `shutdown` の場合は、全結果を確認して `finalize` で引き継ぎを保存する。新しい実験は開始できない。通知が無効または明示的に失敗した場合は、ランナーがジョブの記録を添えて停止状態を保存し、次の手動再開で確認できる。CLI が通知を受理したように見えてターンが起きない場合も、明示的な再開で復旧できる。
