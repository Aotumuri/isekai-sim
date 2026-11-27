# リポジトリ内 ADF

ADF は Codex CLI の依頼を保存し、依頼元の CLI が終了した後に処理します。実験の終了後に同じスレッドを再開するか、明示された起動指示で新しいスレッドを作成します。実験結果の解釈、次の仕事の選択、GitHub Issue の操作は Codex が担当します。

## 起動

macOS または Linux、Python 3.11 以上、公式 Codex CLI が必要です。Codex CLI 0.172.0 のコマンドを使用します。通常の方法で Codex にログインしてください。GitHub の設定は不要です。

リポジトリのルートで次の二つを別々の端末から実行します。先に端末 A で ADF を起動します。起動直後は依頼を待ちます。

```sh
python3 -m adf start --allow-command '["npm","run","test:typecheck"]'
```

端末 B で人間が最初の Codex CLI を起動します。`session` は独立した `codex exec --json` の実行と終了記録を担当します。起動指示は通常のプロンプトで、必要に応じて Skill を指定できます。

```sh
python3 -m adf session 'Developer Skill を使い、承認済みの検証を行ってください。必要なら npm run test:typecheck を ADF に委譲してください。'
```

実験を許可するときは `--allow-command` に完全な引数配列を指定します。複数指定できます。再起動する場合も、継続を許可する配列を指定してください。実験を使わない運用では `--allow-command` を省略できます。ADF は POSIX のファイルロックを使うため、状態はローカルのファイルシステムに置いてください。

別の Git リポジトリに導入する場合は、この `adf/` の追跡対象ファイルだけをリポジトリのルートに置きます。必要な Skill や案内はそのリポジトリに合わせて追加できます。Python パッケージのインストールや初期化コマンドは不要です。旧版を運用中の場合は、切り替え前に旧版の監督とジョブを停止してください。新 ADF の状態は `adf/queue/` に作成されます。旧版の `adf/runtime/` と `agents/runtime/` は過去の記録として参照できます。

## Codex からの依頼

実験を委譲し、実験の成功・失敗どちらでも同じスレッドを再開する場合。

```sh
python3 -m adf run-and-resume '["npm","run","test:typecheck"]'
```

現在の作業を完了し、独立した仕事を新しいスレッドで始める場合。

```sh
python3 -m adf spawn 'Developer Skill を使い、研究ポートフォリオの既存テストを確認してください。'
```

CLI は Codex の `CODEX_THREAD_ID` と起動時に渡した実行識別子を添付します。ジョブ ID が返ったら現在の応答を終了します。実験中の定期確認は不要です。起動指示を送る場合は、人間から許可された作業の範囲を記述します。依頼を登録せずに終了すると、ADF は待機を続けます。

API はローカルのファイル IPC です。CLI が JSON を公開し、ADF が SQLite にコミットしてからジョブ ID を返します。1 回の `codex exec` につき依頼は 1 件です。受領確認が途切れた場合は、同じ実行内で同じ依頼を再送できます。次の `codex exec resume` では改めて依頼を登録できます。

## 運用と障害対応

```sh
python3 -m adf status
python3 -m adf status '<ジョブID>'
python3 -m adf pause
python3 -m adf unpause
```

`pause` は新たな実験・再開・新規起動を止めます。設定は再起動後も保持されます。進行中のプロセスは結果を記録するまで実行を続けます。ADF 本体は端末 A の Ctrl+C で停止できます。ADF を再起動すると、残っているプロセスのロックと完了記録を照合し、処理を再開します。

| 状態 | 確認する内容 |
| --- | --- |
| `waiting` | 依頼元の CLI が終了すると次へ進みます。 |
| `ready_experiment` / `ready_codex` | 実行可能な依頼です。`pause` 中や別の処理が実行中の場合は待機します。 |
| `experiment` / `codex` | プロセス終了と完了記録を待っています。 |
| `done` | Codex の再開または新規起動が正常終了しました。実験の成否は別途 `experiment_result` に記録します。 |
| `blocked` | 依頼元の異常終了、スレッドの不一致、または実験許可の変更を確認してください。 |
| `uncertain` / `launch_failed` / `continuation_failed` | ログと Codex の履歴を確認し、人間が続行を判断します。ADF は自動で再実行しません。 |

ログは `adf/queue/jobs/<ジョブID>/` の `experiment.log`、`codex.jsonl`、`codex.stderr.log`、`worker.log` に記録されます。実験に失敗した場合も、終了コードとログのパスを同じスレッドに渡します。実験コマンドはフォアグラウンドで実行し、終了時に結果を出力する構成にしてください。

ADF はチェックアウトごとに一つのサービスとして動作し、実験と継続を一度に一つずつ処理します。公式 CLI の JSONL に含まれる `thread.started` でスレッドを照合し、OS が依頼元プロセスの終了を返した後に処理を進めます。通常の対話型 Codex CLI や Desktop の既存スレッドを登録する経路はありません。新規スレッドの入力は指定された起動指示です。リポジトリのファイルや Skills は通常どおり参照できます。

Python は標準ライブラリだけを使います。実験は人間が許可した引数配列を公式 `codex sandbox` に渡します。Codex の初回実行・再開・新規起動は、ネットワークを閉じたワークスペース書き込みプロファイルと `approval_policy=never` を使用します。Codex のツールから ADF への書き込みは受付ディレクトリに限ります。管理設定でこのプロファイルや実行が拒否された場合は、通常の管理ポリシーに従ってください。DB とログはリポジトリの Git 管理外に置きます。実行情報のアクセス境界はリポジトリを使用するローカル OS ユーザーです。

## 検証

```sh
python3 -m unittest discover -s tests/adf -v
python3 tests/adf/live_acceptance.py
```

後者は認証済みの公式 Codex CLI を使う実機テストです。一時 Git リポジトリ内で 4 回の Codex 実行を行います。
