# リポジトリ内 ADF

ADF は Codex CLI の依頼を保存し、依頼元の CLI が終了した後に処理します。実験の終了後に同じスレッドを再開するか、明示された起動指示で新しいスレッドを作成します。実験結果の解釈、次の仕事の選択、GitHub Issue の操作は Codex が担当します。

## 起動

macOS または Linux、Python 3.11 以上、公式 Codex CLI が必要です。Codex CLI 0.172.0 のコマンドを使用します。通常の方法で Codex にログインしてください。GitHub の設定は不要です。

リポジトリのルートで次の二つを別々の端末から実行します。先に端末 A で ADF を起動します。起動直後は依頼を待ちます。

```sh
python3 -m adf start --enable-experiments --profile research
```

端末 B で人間が最初の Codex CLI を起動します。`session` は独立した `codex exec --json` の実行と終了記録を担当します。起動指示は通常のプロンプトで、必要に応じて Skill を指定できます。

```sh
python3 -m adf session 'Developer Skill を使い、研究予算の感度を検証してください。このチェックアウト内で実験スクリプトを作り、シードと条件を変えて比較して構いません。'
```

## 実験の許可

`--enable-experiments` は、その起動中に実験の委譲を受け付ける指定です。`session` の指示で人間が研究対象と作業範囲を示します。Codex はその範囲でスクリプトを作ったり、引数を変えたりできます。実験を委譲しない場合は `--enable-experiments` を省略します。`spawn` は引き続き利用できます。

`--profile research` は利用者が用意した公式 Codex 設定プロファイルの例です。省略時は通常の Codex 設定を使います。初回、実験、再開、新規起動に同じ選択を渡します。ADF がサンドボックス、ネットワーク、承認ポリシーを書き換えることはありません。選択したプロファイルには、受付の `adf/requests/` への書き込み、`.codex/adf/` の状態とログの読み取り、`.codex/adf/` の書き込み保護が必要です。たとえば、標準の `workspace-write` は `.codex/` を保護します。独自プロファイルを使う場合はその保護を維持してください。

実験は一時的な非対話 Codex セッションで、通常のコマンド実行ツールに渡します。公式 Codex がサンドボックス、実行ルール、承認、管理者設定を適用します。使用する Codex CLI と設定は、実験の書き込み対象外に置いてください。実験の起動に追加の推論を使い、実行中も補助セッションが残ることがあります。元のスレッドは実験結果が出るまで終了したままです。補助セッションにはコマンドだけを渡し、実験の解釈は元のスレッドで行います。

Codex CLI 0.172.0 の `sandbox` や App Server の `command/exec` では、元のターンの承認をコマンドと一緒に移送できません。非対話の `codex exec` で対話承認を待つこともできません。初回起動・再開・実験の承認動作は CLI の非対話モードと、設定されていれば公式の自動レビューに従います。コマンドが拒否された場合、または実行を確認できなかった場合は、終了コードを空にして通知します。元の実行で得た一時権限や承認は渡しません。補助セッションには指定コマンドのみを実行するよう指示しますが、実行を確認できる範囲は CLI が出力したコマンドイベントです。ADF は確認できない結果を成功扱いせず、再試行もしません。 [Codex App Server](https://developers.openai.com/codex/app-server) · [Codex の実行ルール](https://developers.openai.com/codex/rules)

別の Git リポジトリに導入する場合は、追跡対象の `adf/` をルートへコピーし、ルートの `.gitignore` に `/.codex/adf/` を加えます。状態はローカルのファイルシステムに置きます。旧版から切り替える場合は旧版のジョブと監督を停止してください。旧版の `adf/queue/`、`adf/runtime/`、`agents/runtime/` はそのまま参照できます。旧版のキューに登録された依頼は旧版で取り扱います。

## Codex からの依頼

実験を委譲し、実験の成功・失敗どちらでも同じスレッドを再開する場合。

```sh
python3 -m adf run-and-resume '["python3","test/experiments/research_budget.py","--seed","42"]'
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
| `blocked` | 依頼元の異常終了、スレッドの不一致、または Codex の起動設定の選択変更を確認してください。 |
| `uncertain` / `launch_failed` / `continuation_failed` | ログと Codex の履歴を確認し、人間が続行を判断します。ADF は自動で再実行しません。 |

ログは `.codex/adf/jobs/<ジョブID>/` の `experiment.log`、`codex.jsonl`、`codex.stderr.log`、`worker.log` に記録されます。実験に失敗した場合も、終了コードとログのパスを同じスレッドに渡します。実験コマンドはフォアグラウンドで実行し、終了時に結果を出力する構成にしてください。

ADF はチェックアウトごとに一つのサービスとして動作し、実験と継続を一度に一つずつ処理します。公式 CLI の JSONL に含まれる `thread.started` でスレッドを照合し、OS が依頼元プロセスの終了を返した後に処理を進めます。通常の対話型 Codex CLI や Desktop の既存スレッドを登録する経路はありません。新規スレッドの入力は指定された起動指示です。リポジトリのファイルや Skills は通常どおり参照できます。

Python は標準ライブラリだけを使います。DB、ログ、受付は Git 管理外です。実行情報のアクセス境界はリポジトリを使用するローカル OS ユーザーです。保留中の実験を再開する際は同じプロファイル選択で `--enable-experiments` を指定します。同じプロファイル名の設定内容は Codex が起動時に読み込みます。

## 検証

```sh
python3 -m unittest discover -s tests/adf -v
python3 tests/adf/live_acceptance.py --profile research
```

後者は認証済みの公式 Codex CLI を使う実機テストです。一時 Git リポジトリ内で 6 回の Codex 実行を行います。
