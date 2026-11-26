# プロジェクト内 ADF

ADF は Git チェックアウトごとに専用の Core を起動します。CLI、Web、Codex Skills は同じロールと実行状態を参照します。GitHub Issues が課題の正本です。SQLite、実験、ログ、IPC とバックアップは `adf/runtime/` に保存します。公式 Codex の認証とスレッドは公式の保存先を使います。

## 旧環境を使っていた場合

移行の前に、実行中の実験の終了を確認し、旧 Developer と Desktop の監督を停止します。

1. Desktop の場合は旧アプリを開き、終了時に **安全に停止** を選びます。バックグラウンド継続を選んだ場合は監督が残ります。中央状態は移行完了まで保持してください。
2. さらに旧 `agents/` 版を使っていた場合は、以下のコマンドを順に実行します。`status` の所有者を確認し、セッションが終了してから一致する ID で解放します。すでに停止している場合は停止コマンドを省略し、残った所有権だけを確認します。実験の正常終了を待てない場合は `control.py stop` で取消を要求し、`runner.py list` で終了を確認します。

   ```sh
   python3 agents/tools/research.py status
   python3 agents/tools/control.py graceful "プロジェクト内 ADF へ移行"
   python3 agents/tools/runner.py list
   python3 agents/tools/control.py finalize "実験と記録を確認"
   python3 agents/tools/research.py release '<表示された所有者ID>'
   ```

3. リポジトリのルートからプレビューします。利用していた方だけ実行できます。Desktop を取り込む場合は、最初にその移行を行い、新 Core の作成は後にします。

   ```sh
   python3 -m adf migrate desktop
   python3 -m adf migrate legacy
   ```

4. プレビューの `conflicts` が空、移行元・移行先が停止中であることを確認し、表示された指紋を指定します。

   ```sh
   python3 -m adf migrate desktop --apply '<Desktop の fingerprint>'
   python3 -m adf migrate legacy --apply '<旧 CLI の fingerprint>'
   ```

Desktop は現在のチェックアウトに一致するプロジェクトだけを複製します。セッション、役割設定、予算、実験、成果物と照合中の操作を保持します。保留中だった承認と未配信の起床は失効します。既存のローカル DB やジョブとは自動合併しません。途中で停止した場合は同じ指紋で続行します。異なるパスや Git 実体は安全のため取り込めません。

移行した Desktop の研究実行には現行 Mission が記録されていません。GitHub の実際の進捗と保存済みの範囲を確認した上で、`python3 -m adf research-resume --scope '<再承認する範囲>'` で引き継ぎます。

旧 CLI の DB、JSON、実験とチェックポイントは参照用に `adf/runtime/migration/` に複製します。報告の `checkpoint` と成果物を確認して、管理セッションへの引き継ぎを記述してください。旧 CLI の所有権、起床、Codex スレッド ID は移行しません。Desktop の管理スレッド ID は保持しますが、公式 Codex で取得できない場合はチェックポイントを確認し、新しいメッセージで引き継ぎます。移行元は保持されます。

## 初回セットアップと操作

Python 3.11 以上、公式 Codex CLI の ChatGPT ログイン、GitHub CLI の対象リポジトリへのアクセスが必要です。運用設定は、同梱の例をコピーして編集できます。初期モードは Manual です。GitHub 操作の初期権限は禁止です。

```sh
python3 -m adf init
# adf/runtime/config.toml の github と mission を確認・編集する
python3 -m adf doctor
python3 -m adf start
python3 -m adf gui
```

任意の TOML を使う場合は `init --file <設定ファイル>` を指定します。GUI 起動時はフロントエンドのビルドやインストールが不要です。GUI を閉じても研究は継続します。GUI の端末を閉じた場合は `gui` を再実行し、その起動時だけ有効な URL を開き直してください。

| 操作 | Web GUI | CLI |
| --- | --- | --- |
| Coordinator と相談 | Coordinator を選び、会話欄から送信 | `python3 -m adf send coordinator '相談したい研究方針'` |
| Developer に手動の指示 | Developer を選び、会話欄から送信 | `python3 -m adf send developer '承認した作業'` |
| GitHub の操作を許可 | 設定 → 詳細設定 → GitHub 操作の権限 | `python3 -m adf tracker-policy progress=ask checklist=ask proposal=ask comment=ask complete=ask` |
| Developer の研究を開始 | 「研究を開始」で承認範囲・Issue・予算を入力 | `python3 -m adf research-start '承認済みの検証範囲' 123 --tokens 80000` |
| 承認と送信結果を確認 | GitHub Issues → 操作履歴と承認 | `tracker-review <ID> --approve` / `tracker-reconcile <ID>` |
| 研究を一時停止 | Developer の「停止」または「即時停止」 | `python3 -m adf stop developer [--immediate]` |
| 研究を再開 | Developer の「再開」。条件が変わった場合は「研究の再開条件を確認」 | `python3 -m adf research-resume` |
| 通常会話を続ける | 会話を送信 | `python3 -m adf send <ロール> '<メッセージ>'` |
| 監督を停止 | 設定 → 監督を停止 | `python3 -m adf stop [--immediate]` |

Issue 番号は実際に承認した課題に差し替えてください。最初に既存の分類、`status:ready`、依存関係を確認します。承認待ちで Developer を停止すると、その研究の承認は失効します。送信済みで結果不明の操作は GitHub で照合し、その結果を確認してから再開します。研究終了の根拠は GitHub または研究報告に残してください。

### 運用モード

- **Manual** は Issue を一件ずつ指定し、GitHub 書き込みを人間が確認します。
- **Controlled** は承認済み Issue の中から依存関係と優先度に従って進めます。
- **Autonomous** は同じ明示範囲で、着手可能な課題が現れるまで推論なしで再確認できます。既定の観測トークン上限は 0 です。
- **Research Autonomous** は承認範囲内で着手先がなくなったとき、先行結果と Issue を確認する読み取り専用の探索を一度実施できます。探索だけを許可する場合は Issue 番号を空欄にします。候補は一件まで下書きします。既定では人間が起票を承認します。`discovery_issue = "policy"` を明示し、実効の起票権限が `allow` の場合だけ Core が送信できます。起票後の着手には別に承認範囲と Issue を指定します。

`research-preset` で設定をプレビューでき、`--apply` で保存します。枠や権限は運用モードを変えても広がりません。観測トークンの 0 は ADF の予算にだけ適用されます。アカウントの公式利用枠と、トークン・ターン・実験の記録は別々に表示します。

## 設定変更・バックアップ・更新

Mission と通常の運用 TOML は、GUI の詳細設定、直接編集、停止中の `python3 -m adf config --file <ファイル>` で変更できます。`python3 -m adf restart` で反映します。再起動は研究を自動開始しません。ファイルのプリセット設定が前回から変わった場合、その設定を取り込みます。GUI・CLI のプリセット設定は次の研究実行に適用します。ロール設定は対象ロールを停止してから変更します。TOML の任意の `[tracker]` セクションは編集後の再起動で反映されます。GUI・CLI での GitHub 権限の変更は即時反映され、リポジトリの上限は `adf/policy.toml` で定義します。

1. `python3 -m adf stop` を実行し、`status` が停止を示すまで待ちます。
2. `python3 -m adf backup` で DB、設定、成果物と移行記録を保全します。`python3 -m adf update` も停止中に保全を行い、更新前のリビジョンを表示します。Web ではロールの停止後に「更新前の保全」を実行できます。
3. 信頼できるローカル変更を人間が確認して適用します。更新元からの自動取得・適用は行いません。
4. `python3 -m unittest discover -s tests/adf` と `python3 -m adf doctor` を実行し、`start` または `gui` で監督を起動します。必要な研究だけ明示的に再開します。

更新に失敗した場合は監督を停止し、更新前の ADF ソースとバックアップを別の場所で照合します。復元作業まで現在の `adf/runtime/` とバックアップの両方を保全してください。監督が起動しない場合は `adf/runtime/supervisor.log` と `doctor` を人間が確認します。

## 権限と現時点の制約

- 管理ロールは公式 Codex サンドボックスを使用します。Developer がソースを変更でき、Coordinator と追加ロールは読み取り専用です。ADF 本体、ロール定義、実行状態、認証、Git メタデータは保護されます。コミットは人間が差分・試験結果を確認し、通常の Git ツールで行います。push や PR の仲介は提供しません。
- コミットが完了条件の研究では、運用 Config の `[git]` に `require_commit = true` を追加し、開始時に対象ファイルを承認します。ADF は課題開始時の HEAD を親とするコミットと、そのコミットを元にした成功実験を確認してから課題を進めます。設定と実効権限は [Git コミットの権限と完了条件](GIT_COMMITS.md) を参照してください。
- Web は `127.0.0.1` のプロジェクト別ポートで動き、起動 URL に含まれる接続情報が必要です。接続情報と実行時データのフォルダは共有しないでください。CLI とファイル IPC の信頼境界はローカル OS ユーザーです。
- Skill の現在のスレッドでは相談と状態確認ができます。既存の外部スレッドを管理権限で引き継いだり、自動的に起床したりすることはできません。管理下で行う作業は専用セッションを開始してください。 [公式 App Server](https://learn.chatgpt.com/docs/app-server)
- 原則は固定ソースからの Snapshot 実験です。待機中の監視と完了通知に推論を使いません。Core／Mac が停止した後は状態を確認して人間が再開します。送信結果が不明な操作は自動で再送しません。
- 続きの実装と受け入れ条件は [設計とロードマップ](PROJECT_LOCAL.md) を参照してください。従来の説明と実測記録は Desktop 時代の資料です。 [旧 Desktop 受け入れ記録](ACCEPTANCE.md)
