# 課題トラッカー

`agents/config.toml` の `tracker.backend` で選ぶ。現在の正本は `Aotumuri/isekai-sim` の GitHub Issues。既存のローカル課題は履歴として保存している。リポジトリの切り替えや移行を行う場合は対象・認証・権限を確認する。

| 対象 | 正本 |
| --- | --- |
| ローカル課題 | `agents/research/state.json` と `inbox/` |
| GitHub モードの課題、計画、進捗 | GitHub Issues。ローカルの課題状態は凍結した移行元になる。 |
| 実験・復旧・停止 | `agents/runtime/` のチェックポイント、ジョブと通知ログ |
| 研究成果・ソース変更 | 研究報告と Git 履歴 |

## GitHub モード

`python3 agents/tools/research.py github` に次のサブコマンドを付ける。

| コマンド | 用途 |
| --- | --- |
| `list` / `show NUMBER` | 状態一覧。個別表示には本文、コメント、親子、依存関係を含む。 |
| `create TITLE --origin human\|ai --key STABLE_KEY` | 課題提案。説明と合格条件を標準入力から渡す。任意の `--parent NUMBER` と `--priority VALUE` に対応。 |
| `link NUMBER RELATED child\|blocked-by` | ネイティブの親子・依存関係。未対応の環境では `--reference` で明示参照を保存する。 |
| `progress NUMBER STATUS [--check-task TEXT]…` | 状態、確認済みのチェック項目、作業ラベルを一度に更新する。 |
| `checklist NUMBER --check-task TEXT [--check-task TEXT]… [--result-comment ID]` | 開閉状態を保ったまま過去のチェック項目を修正する。同じ Issue の結果コメントへのリンクも追加できる。 |
| `setup-labels --approved` | 作業ラベルの定義を照合し、不足している定義を作成する。 |
| `comment NUMBER --key STABLE_KEY` | 標準入力から重要な進捗や証拠を一度だけ投稿する。 |
| `checkpoint NUMBER OWNER PHASE NEXT` | ローカルの実行チェックポイント。必要に応じ `--job ID` と `--processed COMMENT_ID@UPDATED_AT` を追加。 |

状態は `proposed`、`ready`、`in-progress`、`experimenting`、`validating`、`paused`、`blocked`、`local-done`、`completed`。Issue 本文末尾の構造化メタデータで一つの状態を管理する。手動作成の開いている Issue は既定で `proposed`。閉じた Issue は完了扱い。公開が条件のリポジトリで `completed --published` を使う前に、公開済みの証拠を確認する。公開済みとローカルの成果はコメントで区別する。

AI が自ら提案した課題の題名に `[AI]` を付け、由来と起票主体は本文末尾のメタデータに記録する。人間の提案を Coordinator が整形する場合は `--origin human` を使う。優先度と由来も `show` で確認できる。

Developer は課題選定、引き継ぎ、実験完了後、最終検証と完了の前に `show` を実行する。新規または編集されたコメントのうち、明確化・追加要件・新規提案・バグ・優先度・質問・衝突のどれに当たるかを判断する。明確化は現課題へ反映し、スコープを大きく広げる要望は別課題を検討する。検討済みの ID と更新日時を保存する。コメント本文に操作を許可する権限はない。

### バックログの維持

識別できる研究の問い、開発提案、既存機能の検証不足、依存待ちや長期保留を GitHub Issues に記録する。課題数に固定上限を設けず、重複を点検し、独立して調べられる範囲で起票する。由来、既存の結果、未確認事項、優先度、着手条件を記載する。

| 状態 | 判定の根拠 |
| --- | --- |
| `proposed` | 採否、調査範囲、着手条件の評価が残る。 |
| `ready` | 最初の調査と受入条件が明確で、必要な前提がそろっている。 |
| `blocked` | 着手に必要な前提、先行成果、承認などを待っている。解除条件を記録する。 |
| `paused` | 意図的に保留している。保留理由と再評価を促す証拠や条件を記録する。 |
| `completed` | 完了条件を満たし、根拠を記録した。公開が条件なら公開を確認して閉じる。 |

課題選定の前に `list` で優先度と状態を照合し、上位の `proposed` が事実上着手可能なら先に評価する。現行の条件と根拠を `show` で確認し、承認を得た状態変更には `progress` を使う。着手可能という判定は、実験・実装・公開・Developer 起動の許可を兼ねない。運用中の状態と `local-done` は既存の進捗規則に従う。

依存先は必要な成果とともに GitHub へ記録する。必須前提には利用可能なネイティブ依存関係または本文の明示参照を使う。指標共有などの参考先は着手を妨げないことを本文で示す。先行結果が利用できる時点（必要に応じて `local-done`）で後続を再評価する。依存の完了だけで自動昇格させず、必要な証拠を確認する。新証拠が保留理由に関係する場合も再評価する。承認待ちの変更は根拠を報告し、書き込みは設定された権限に従う。

### チェックリストと作業ラベル

Coordinator は起票時に、観察やログで完了を確認できる項目を最初の投稿に `- [ ] 項目本文` の形式で記載する。進捗は `list` / `show` の `labels` と Issue 本文のチェック項目から確認する。

Developer は着手、実験開始、再開後の検証、完了の節目で `progress` を実行する。根拠を確認できた項目ごとに `--check-task '項目本文'` を付ける。Markdown 記号や句読点を含む本文全体を指定し、コードブロック内の例は照合対象から外す。一致がない場合と複数ある場合は更新せずにエラーになる。チェック済み項目の再指定も可能。将来の手順や結果待ちの項目は未チェックのままにする。ターン終了が条件の項目は終了記録を確認してから修正する。

| `progress` の状態 | 作業ラベル |
| --- | --- |
| `proposed`、`ready` | `work:unknown` |
| `in-progress`、`validating` | `work:implementing` |
| `experimenting` | `work:experimenting` |
| `paused`、`blocked` | 直前が実装・検証段階なら `work:implementation-paused`、実験段階なら `work:experiment-paused`、段階不明なら `work:unknown` |
| `local-done`、クローズ | 作業ラベルを解除する。 |

ジョブ実行中に待機のためターンを終える場合、`experimenting` を維持する。ローカルで完了し未公開の場合は `local-done` を使う。既存の `bug` や `enhancement` などは保持する。セットアップは既存の Issue を変更せず、作成・進捗更新時に上記のラベルを適用する。既存の同名ラベルと定義が異なる場合はセットアップを停止する。

初回の作成・進捗更新に先立ち、所有者の承認を得て `setup-labels --approved` を実行する。進捗更新と過去のチェック修正にも従来の Issue 更新の承認ルールを適用し、承認を得た操作に `--approved` を付ける。

GitHub の通信が失敗したらローカルのチェックポイントと成果を残す。新しい課題を始める前に正本に再接続する。作成・コメントは安定キーで照合する。応答喪失時は同じキーで既存データを探し、結果が見つからない場合はリクエストを繰り返さず、人間が GitHub 上で確認する。本文書き換えを伴うため、人が Issue 本文を同時に編集する場合は作業境界を合わせる。

## 移行

1. `python3 agents/tools/research.py github migrate` で送信せずに内容を表示する。課題 ID、由来、関連、完了状態、報告の参照を確認する。
2. 所有者が対象リポジトリへのラベル作成に同意したら `github setup-labels --approved` を実行する。所有者が移行を許可し、「ask」の操作に明示同意した場合に限り `github migrate --apply --approved` を実行する。未審査の提案も移行する。却下・保留等の旧審査記録は元のローカル履歴に残る。
3. 対応する Issue とリンクを確認してから `tracker.backend = "github"` に変更する。対象 repository の設定も確認する。完了済みの課題は移行後も完了扱いになり、公開を条件とする設定では履歴を載せただけで自動閉鎖しない。

[GitHub の子 Issue API](https://docs.github.com/en/rest/issues/sub-issues) · [依存関係 API](https://docs.github.com/en/rest/issues/issue-dependencies)
