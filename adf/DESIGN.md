# 独立 ADF の設計と受け入れ

## 調査

作業ツリーのリモートは `Aotumuri/isekai-sim`。同じチェックアウトを参照資料として扱い、独立モジュールを `adf/` に置く。調査時の基点は `a9471eb`。実験、Issue、既存の稼働状態の更新はこの作業に含めない。

| 対象 | コード・テストでの確認 |
| --- | --- |
| Coordinator・Developer | `.agents/skills/` で役割文書を起動。Coordinator は提案や課題を整理する。Developer が作業ツリーと成果を扱う。Python CLI の `research.py ownership` は旧所有者 ID を確認して claim、release、handoff を行う。 |
| Worker | `.codex/agents/worker.toml` のネイティブサブエージェント。既存設定は一枠、再委任制限は役割指示。ADF では初期値として無効にし、同時実行枠を使う主体は独立ロールに限定する。 |
| 課題 | `github_tracker.py` は `gh api` を使用し、出所、分類、依存、候補選定、チェックリストを管理する。書き込み許可は `policy.permit`。起票・コメントの冪等性や並行ラベル編集のテストがある。 |
| 所有・復旧 | `research.py` と `control.py` が所有者、Issue、ジョブ、次の行動、停止世代を保存。実装は JSON、原子的な書き換え、`flock`。SQLite に関する既存の障害は Codex 側の状態 DB で発生していた。 |
| 実験 | `runner.py` は Git リビジョンを tar に固定し、独立した監督プロセスで制限時間、プロセスグループ、ログ、成果物を管理する。失敗、タイムアウト、再起動、子プロセスの取消の回帰テストがある。 |
| 通知 | `notify` と `wake_scope` が宛先、停止世代、チェックポイント、配送状態を確認。配送が不明な要求は重ねて送らない。 |
| Runtime Adapter | 現行実装の接点は `runner.py` の CLI 検出と Queue 呼び出し。ADF は、ランタイムを独立のアダプターから起動し、プロトコル全体を受け持つ。 |

Issue #7 では専用 DB・ソケットと受付試験用経路で、300 秒の実験後に元の TUI スレッドを再開できた。Issue #28 の通常経路では実験は成功し、通知は SQLite オープン拒否で失敗した。追加調査では既定ソケット接続にも制限があり、Seatbelt に優先拒否があった。今回も管理された開発環境の中では 0.172.0 の起動時に SQLite コード 14 を再現した。ユーザーとして起動した独立プロセスでは同じ公式バイナリの標準入出力で初期化に成功した。 [Issue #7](https://github.com/Aotumuri/isekai-sim/issues/7) · [Issue #28](https://github.com/Aotumuri/isekai-sim/issues/28) · [既存の実測報告](https://github.com/Aotumuri/isekai-sim/blob/94fb666/agents/research/reports/issue-28-normal-completion-notification.md)

## 選定

| 選択肢 | 判定 |
| --- | --- |
| Codex App Server（stdio） | 採用。スレッド作成・復元、応答ストリーム、steer、interrupt、エラー分類、利用量通知、既存認証、推論を伴わない command/exec を一つのクライアントで扱える。0.172.0 の生成済み JSON Schema を照合した。実験登録の dynamic tool は実験的 API なので、このバージョンを初期の検証対象とする。 |
| Codex SDK | スレッド継続やストリーム取得には適する。承認、割り込み、限度数照会、実験プロセスも扱うアプリでは App Server を直接使う方が少ない構成で足りる。 |
| CLI `exec --json`・Queue | 単発の処理と既存 TUI への送信には使える。受動的な公式イベント、同じ接続での steer、プロセスの実行と停止を一つの監督が制御するには別の仕組みが要る。 |
| Python + Tk | ローカルの Homebrew Python に Tk 拡張がなく、Apple 付属 Tk は WindowServer への接続前に OS バージョン不一致で終了したため見送った。 |
| Python + Swift/AppKit | 採用。Python は既存の Git 運用、SQLite、asyncio、unittest を再利用できる。GUI は現環境の Apple Silicon でビルドできる AppKit を使い、Python の小さなブリッジを通じて CLI と同じ IPC に接続する。監督側に GUI 依存はない。Qt は UI の拡張性があるがバンドルと依存管理が増える。 |
| Tauri・Electron | Web ベースの UI を複数 OS で共有できる。Rust/Node のビルドや実行環境を追加するため初期版では見送った。Go/Rust に監督を移す判断には常駐資源の比較測定が必要。 |

[Codex App Server](https://developers.openai.com/codex/app-server) · [Codex SDK](https://developers.openai.com/codex/sdk) · [Codex Permissions](https://learn.chatgpt.com/docs/permissions) · [ChatGPT 契約での Codex](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)

## 採用構成

- **中央設定とプロジェクト方針の併用。** ADF はロールの上書き、利用条件、許可済み実験テンプレート、ターン・ログの識別子をユーザー専用 SQLite に保存する。Codex 自身は公式のスレッド保存先を使う。リポジトリ内の Skills、AGENTS.md、報告、GitHub Issue は従来の管理先で扱う。既存 ID の自動インポートは行わず、人間の指示から ADF のスレッドを作る。
- **単一作業ツリーと単一の書き手。** 登録時に実ディレクトリと Git の同一性を記録する。ロールごとの稼働枠はデーモン全体で一枠、書き手は Developer のみ。Coordinator と追加ロールには書き込み権限がない。Git Worktree は無条件に作らない。Worktree の書き込み競合を防いでも同一 Issue の重複処理は防げないため、課題正本は既存のトラッカーに残す。既存 Developer との同時運用は移行手順で避ける。
- **公式サンドボックス。** App Server の名前付き権限を接続側で固定する。エージェントが読めるのは作業ツリーと最小ランタイムパスで、Developer だけがソースを変更できる。外部ネットワーク、追加権限承認、Apps、MCP、ネイティブ委任を無効にする。監督の権限・IPC・認証は実験に渡さない。Git のホスト側処理には読み取り用の固定した plumbing コマンドを使い、プロジェクトに定義されたフィルターやフックを実行しない。
- **ターンから分離した実験。** Developer は人間がターン開始時に選んだテンプレートを一度だけ登録できる。監督は Git オブジェクトから通常ファイルを分離ディレクトリに復元し、公式 `command/exec` を呼ぶ。監督は実験の終了と起動元ターンの終了を別に待ち、世代、スレッド、起動元ターン、通知状態を照合してから再開を一度予約する。停止要求は世代を更新する。継続の予約後に通信結果が不明なときは自動再送せず、状態を確認して再開する。この方式は外部 RPC を含む厳密な exactly-once ではなく、曖昧な場合に取りこぼしを許容する at-most-once。
- **プロセスと IPC。** GUI と CLI が 0700 配下のファイルメールボックスで同一の監督に接続する。監督は操作を処理する前に要求ファイルを消費し、状態変更と履歴は SQLite に記録する。通常の OS ユーザーを信頼境界とし、別ユーザーや別ホストへのアクセスは提供しない。ローカル IPC と画面の更新間隔は推論を発生させない。Codex の親監視プロセスがリースを保持し、監督を失うと管理プロセスの終了を開始する。
- **利用量。** 開始前に公式の購読枠を照会し、枠が不明または枯渇している場合は進めない。トークンはスレッドの通知値、ターン数は ADF の送出回数。これらから内部のモデル往復回数や請求額は算出できない。回復を設定した場合、サーバーが返した枯渇枠とリセット時刻から一度だけ再照会する。認証エラー、切断、再起動後は状態を保存して人間の判断を待つ。

## 段階と判定条件

| 段階 | 受け入れ条件 |
| --- | --- |
| A. 既存・公式調査 | Issue と既存コード・24 件の回帰で根拠を照合。ローカル 0.172.0 の schema と auth/limits を確認。 |
| B. 設計 | roles、project、session、job、event を永続化し、停止世代と一意制約による重複防止を先に確立。 |
| C. 基盤と GUI | 公式 RPC で開始、終了、分離実験、再開。GUI と CLI で同じ状態を利用し、初回のウィンドウ終了とバックグラウンドからの再接続を検証可能にする。 |
| D. 受け入れ | 模擬ランタイムで停止・同時稼働・障害・重複を再現。実機で合成ファイルの権限境界、実験終了前のターン終了、ゼロ追加要求、継続一回を測る。 |
| E. 配布 | .app のローカルビルド、台帳・制約・復旧手順を整備。次は GUI 実機試験の固定化、既存課題・チェックポイントの移行、Git コミットの権限を保った操作、インストーラー署名、他 OS 対応。 |

```sh
python3 -m unittest discover -s tests/adf -v
python3 -m unittest discover -s agents/tools/tests
PYTHONPATH=. python3 tests/adf/live_acceptance.py
PYTHONPATH=. python3 tests/adf/live_acceptance.py --run-turns
```

最後のコマンドは、通常の macOS ユーザー環境で一時 Git リポジトリと 35 秒の sleep を用いる。購読枠内で最大二ターンを実行する。第三者のプロジェクトや既存 Codex スレッドは使わない。

## 実測結果

Apple Silicon、macOS 15、Homebrew Codex CLI 0.172.0、Python 3.14 で確認した。

| 検証 | 観測 |
| --- | --- |
| 公式 App Server | 既存 ChatGPT ログインを認識し、公式購読枠を取得。合成ファイルで作業領域外・領域内の `.env` 読み取りを拒否し、読み取りロールの書き込みを拒否、書き込みロールの領域内書き込みを許可。 |
| 実機の実験サイクル | 35 秒の sleep を登録。初回ターン終了から実験終了までは 32.89 秒。待機中の追加ターン要求 0 件、トークン通知の累計差 0、実験後の継続 1 件、全体 2 件。モデル内部の通信回数は計測対象外。 |
| 実機のセッション復元 | App Server を終了・再起動してから `thread/resume` が元と同じ ID を返した。 |
| 統合回帰 | 新規 ADF 8 件。固定リビジョン、継続の重複防止、穏やかな停止と即時停止、同時稼働・重複排除、追加指示、障害後の復元、利用枠、再接続、実験のユーザー許可を確認。既存基盤の 24 件が通過。 |
| GUI | arm64 の .app をビルドし、合成データによる AppKit ウィンドウの表示を検査。GUI での実プロジェクト登録、実際の対話操作、終了ダイアログからの再接続の通し試験は未実施。再接続時の所有権と継続は IPC の統合テストで確認。 |
