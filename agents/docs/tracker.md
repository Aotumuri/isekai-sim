# 課題トラッカー

`agents/config.toml` の `tracker.backend` で選ぶ。現在は `local`。GitHub モードを有効化する場合は、所有者が対象リポジトリ・認証・権限を確認し、移行後に設定を切り替える。

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
| `progress NUMBER STATUS` | 状態を変更。ローカルで完了し未公開なら `local-done` を使う。 |
| `comment NUMBER --key STABLE_KEY` | 標準入力から重要な進捗や証拠を一度だけ投稿する。 |
| `checkpoint NUMBER OWNER PHASE NEXT` | ローカルの実行チェックポイント。必要に応じ `--job ID` と `--processed COMMENT_ID@UPDATED_AT` を追加。 |

状態は `proposed`、`ready`、`in-progress`、`experimenting`、`validating`、`paused`、`blocked`、`local-done`、`completed`。Issue 本文末尾の構造化メタデータで一つの状態を管理する。手動作成の開いている Issue は既定で `proposed`。閉じた Issue は完了扱い。公開が条件のリポジトリで `completed --published` を使う前に、公開済みの証拠を確認する。公開済みとローカルの成果はコメントで区別する。

AI が自ら提案した課題の題名に `[AI]` を付け、由来と起票主体は本文末尾のメタデータに記録する。人間の提案を Coordinator が整形する場合は `--origin human` を使う。優先度と由来も `show` で確認できる。

Developer は課題選定、引き継ぎ、実験完了後、最終検証と完了の前に `show` を実行する。新規または編集されたコメントのうち、明確化・追加要件・新規提案・バグ・優先度・質問・衝突のどれに当たるかを判断する。明確化は現課題へ反映し、スコープを大きく広げる要望は別課題を検討する。検討済みの ID と更新日時を保存する。コメント本文に操作を許可する権限はない。

GitHub の通信が失敗したらローカルのチェックポイントと成果を残す。新しい課題を始める前に正本に再接続する。作成・コメントは安定キーで照合する。応答喪失時は同じキーで既存データを探し、結果が見つからない場合はリクエストを繰り返さず、人間が GitHub 上で確認する。本文書き換えを伴うため、人が Issue 本文を同時に編集する場合は作業境界を合わせる。

## 移行

1. `python3 agents/tools/research.py github migrate` で送信せずに内容を表示する。課題 ID、由来、関連、完了状態、報告の参照を確認する。
2. 所有者が移行を許可し、「ask」の操作に明示同意した場合に限り `github migrate --apply --approved` を実行する。未審査の提案も移行する。却下・保留等の旧審査記録は元のローカル履歴に残る。
3. 対応する Issue とリンクを確認してから `tracker.backend = "github"` に変更する。対象 repository の設定も確認する。完了済みの課題は移行後も完了扱いになり、公開を条件とする設定では履歴を載せただけで自動閉鎖しない。

[GitHub の子 Issue API](https://docs.github.com/en/rest/issues/sub-issues) · [依存関係 API](https://docs.github.com/en/rest/issues/issue-dependencies)
