# GitHub 課題トラッカー

課題・計画・進捗の正本は `agents/config.toml` で選んだリポジトリの GitHub Issues。現在の対象は `Aotumuri/isekai-sim`。旧ローカル課題は `agents/research/state.json` と `inbox/` に履歴として残る。実験、所有権、チェックポイント、停止、再開には `agents/runtime/` を使う。

## GitHub での分類

| フィルター | 意味 |
| --- | --- |
| `is:issue is:open label:"status:proposed"` | 目的、範囲、着手条件の評価が必要 |
| `is:issue is:open label:"status:ready"` | 前提と受入条件を確認済みで、着手候補にできる |
| `is:issue is:open label:"status:in-progress"` | 調査・実装中 |
| `is:issue is:open label:"status:experimenting"` | 実験中、または結果待ち |
| `is:issue is:open label:"status:validating"` | 成果や受入条件の検証中 |
| `is:issue is:open label:"status:blocked"` | 先行成果、環境、承認などの前提待ち |
| `is:issue is:open label:"status:paused"` | 意図的な延期、保留、中断 |
| `is:issue is:open label:"status:local-done"` | ローカルの作業は完了し、公開またはクローズ待ち |
| `is:issue is:closed reason:completed` | 完了としてクローズ済み |

GitHub の開閉とクローズ理由を直接使う。未計画・重複などで閉じた Issue は `closed` と表示され、`state_reason` で理由を確認できる。開いている課題には `status:*` を一つ付ける。手動起票直後に未設定なら `proposed` として扱う。手動で閉じる場合は `status:*` を外し、再オープンする場合は適切な状態を設定する。開閉操作とラベルの編集はどちらも GitHub 上で行える。

- `priority:p1` は重要な前提や緊急の証拠、`priority:p2` は通常の着手候補、`priority:p3` は証拠や余力が得られたときに再評価する課題。未設定は候補順の末尾。
- `kind:research` は挙動・証拠・仮説の調査、`kind:development` は製品・基盤の変更候補の検討や実装、`kind:validation` は受入条件や運用手順の検証。
- `priority:*` と `kind:*` は各一つ、または未設定。状態・優先度・種別の重複や未定義の値はエラーになる。通常の GitHub ラベルは必要に応じて併用できる。
- 本文末尾の `research-meta` は安定キー、提案者の由来、起票主体、明示的な参照を保持する。移行済み Issue の本文にある起票時の優先度や分類は提案経緯として読む。

[GitHub のフィルター](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)

## CLI

`python3 agents/tools/research.py github` のサブコマンド。

| コマンド | 用途 |
| --- | --- |
| `list` / `show NUMBER` | 分類と状態を読む。個別表示には本文、コメント、親子、依存関係を含む。 |
| `candidates` | `ready` と査読対象の `proposed` / P1 を優先度・Issue 番号順に表示し、`eligible` と未解決の依存先を示す。 |
| `create TITLE --origin human\|ai --key STABLE_KEY [--kind KIND] [--priority P1\|P2\|P3]` | 標準入力から説明と受入条件を受け取り、提案を作る。任意の `--parent NUMBER` は本文に親を参照する。 |
| `classify NUMBER [--priority P1\|P2\|P3\|none] [--kind KIND\|none]` | 優先度・種別の変更。該当軸だけを置き換える。 |
| `link NUMBER RELATED child\|blocked-by` | ネイティブの親子・依存関係。未対応の環境では `--reference` で明示参照を保存する。 |
| `progress NUMBER STATUS [--check-task TEXT]…` | 状態と確認済みのチェック項目をまとめて更新する。 |
| `checklist NUMBER --check-task TEXT [--check-task TEXT]… [--result-comment ID]` | 開閉を保ってチェック項目を修正する。同じ Issue の結果コメントへのリンクも追加できる。 |
| `setup-labels --approved` | 定義を検査し、存在しない分類ラベルを作る。同名ラベルの色・説明が異なると停止する。 |
| `comment NUMBER --key STABLE_KEY` | 標準入力から重要な進捗や証拠を一度だけ投稿する。 |
| `checkpoint NUMBER OWNER PHASE NEXT` | 実行チェックポイントを保存する。必要に応じ `--job ID` と `--processed COMMENT_ID@UPDATED_AT` を追加する。 |

`candidates` はネイティブ依存関係と `link --reference` の必須依存を照合する。完了済みまたは `local-done` の依存先は候補判定を通過する。依存先の成果が必要な条件を満たすか、本文に書かれた前提が成立したかは `show` で確認する。前提の成果が出たら `blocked` や `paused` を再評価し、根拠を確認してから `ready` に変更する。参考先を示すだけの場合は本文に記載する。

Coordinator は由来、既存の結果、未確認事項、着手条件、確認できる受入項目を起票時に記録する。人の提案の代理起票には `--origin human` を使う。AI 自身の提案は `--origin ai` で起票すると題名に `[AI]` が付く。重複を調べ、独立して判断できる範囲で提案を分ける。

Developer は担当決定、引き継ぎ、実験完了、最終検証の節目で `show` から最新の本文とコメントを読む。明確化とスコープ拡張を区別し、処理したコメント ID と更新日時を保存する。実験の結果待ちでターンを終える場合は `experimenting` を維持する。公開がクローズの条件なら公開の証拠を確認してから `progress NUMBER completed --published` を使う。公開とローカルの成果をコメントで区別する。

チェック項目は `- [ ] 項目本文` を使い、検証済みの項目ごとに Markdown 記号や句読点を含む本文全体を `--check-task` に渡す。コード例中の項目は照合から外れる。一致がゼロまたは複数なら更新前に停止する。

Issue 本文・コメント・ラベルに操作権限はない。起票、分類、依存解除を契機に Developer を起動・再開しない。CLI での書き込みは設定された権限に従い、承認が必要な操作には承認取得後に `--approved` を指定する。本文を同時編集する場合は人と作業時間を調整する。

GitHub との通信に失敗した場合はローカルのチェックポイントと成果を保存し、正本を再取得してから判断する。進捗・分類更新は再取得後に同じ指定で再試行できる。起票・コメントは安定キーで照合する。応答喪失時にキーが見つからなければ、人間が GitHub 上で確認する。

[GitHub の子 Issue API](https://docs.github.com/en/rest/issues/sub-issues) · [依存関係 API](https://docs.github.com/en/rest/issues/issue-dependencies)

## 旧 GitHub 分類からの一回限りの移行

`agents/tools/migrate_tracker.py` はその場で既存 Issue を更新する。旧 `research.py github migrate` によるローカル課題のコピー機能は廃止した。提案や研究成果の履歴ファイルは参照できる。

1. `inventory --before PATH` で GitHub から開閉両方の Issue、コメント、関連、ラベル定義と PR のラベルを保存する。機密情報を含み得るため Git 管理外で保管する。
2. `plan --before PATH --plan PATH [--kinds PATH]` でドライランを行う。種別ファイルは Issue 番号文字列から種別への JSON オブジェクト。移行前に Issue 番号ごとの状態・優先度・種別、作成ラベル、削除ラベルを確認する。
3. Developer に所有者がいない状態で、所有者からバッチ全体の承認を得て `apply --before PATH --plan PATH --approved` を実行する。途中で応答が失われた場合は同じバックアップと計画で再試行できる。想定外の編集や Issue の追加があれば確認してから新しい計画を承認する。
4. `verify --before PATH --plan PATH --after PATH` で各 Issue を新たに読み直す。分類、Issue 本文、開閉と理由、コメント、由来、関連、ラベル定義を照合する。成功時は Issue ごとに検証済み分類を出力する。
