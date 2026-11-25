# 自律研究の復元と統合計画

## 比較と責務

| 基点 | 調査結果 |
| --- | --- |
| isekai-sim `94fb666` | AppKit、SQLite、公式 Codex App Server、待機中の追加推論ゼロ。停止後の再送に未定義変数があり、IPC 経由で監督停止へ波及し得た。調査時のローカルと GitHub の main が一致。 |
| adf `879e3e2` | Copier テンプレートに SQLite の所有権、ライフサイクル、ジョブ、wake 受領、操作履歴を追加。移行と JSON 互換、ストレージ回帰を含む。 |
| adf `578433e` | Codex CLI 検出・Queue を RuntimeAdapter に分離。Issue 分類・依存、環境検出、CI を強化。調査時の公開 main と一致。ローカルには SQLite と Runner の未コミット変更が 8 ファイルあった。 |

[Desktop](https://github.com/Aotumuri/isekai-sim/commit/94fb666) · [SQLite](https://github.com/Aotumuri/adf/commit/879e3e2) · [運用強化](https://github.com/Aotumuri/adf/commit/578433e)

汎用 Desktop は Aotumuri/adf のトップレベルの `adf/` と `tests/adf/` として統合する。Copier の `template/` を維持し、下流更新と Desktop 配布を分ける。isekai-sim のシミュレーション、設定、研究方針、Skills、研究記録と GitHub Issues は元のプロジェクトに置く。Desktop と旧テンプレートの DB は別のスキーマを持つ。監督は旧プロジェクトの Python をホスト権限で import しない。

## ロードマップと実装

1. 停止済み・中断済みの再送と、IPC の障害分離を先に検証する。
2. SQLite に課題、依存、優先度、承認済み実行範囲、実験コード、結果、継続状態を記録する。実験完了か根拠付き課題完了でのみ次のターンを開く。ロールの排他、停止世代、回数と利用枠を維持する。
3. App Server の `command/exec` で固定 HEAD のソースと Python 標準ライブラリを使う。専用プロファイルが追加するのはインストール済み Python の読み取り。ネットワークと資格情報のアクセスを制限する。壁時計タイムアウト、CPU 時間、出力ファイル単位の制限を設ける。
4. GitHub REST の型付き操作を公式 `gh api` に委譲する。モデルは下書きのみ作成する。GitHub への書き込みには操作別ポリシーと人間の確認が必要。旧 JSON/SQLite を照合し、共有 `state.lock` に従う旧 Developer と Desktop の同時使用を抑止する。
5. 公開済み adf 基点の分離チェックアウトで Copier の回帰と Desktop の試験を比較する。専用 GitHub リポジトリでの実書き込み、大きな実験の耐久性、GUI の通し操作は次の検証対象。

[Codex App Server と承認](https://learn.chatgpt.com/docs/app-server) · [Codex 権限](https://learn.chatgpt.com/docs/permissions) · [GitHub Issue 依存 API](https://docs.github.com/en/rest/issues/issue-dependencies)

## 制約と運用

- Git メタデータは読み取り専用。Developer は差分、検証結果、コミット候補の説明を残す。人間が通常の Git クライアントで差分を確認し、対象ファイルだけをステージしてローカルコミットする。Codex の追加権限要求でサンドボックス外実行を許す経路は採用していない。
- 実験は一セッション一件ずつ。同一計画内で複数件を順次実行できる。未コミット変更は通常の Developer ターンで検証する。スナップショット実験で検証する場合は、確認済みコミットに含める。Node や Python の外部依存キャッシュ、ネットワークインストール、並列実験と Worker は今後の対応。
- 実験の成果物はスナップショット内に残る。空きが 512 MiB 未満なら新規スナップショットを作らない。ログは最大 256 KiB、成果物一覧は直下 200 エントリ、読み取りは最大 64 KiB、モデルは 4 KiB 単位。総容量の強制上限や自動削除は未実装。監督を停止してからバックアップと整理を行う。
- GitHub の提案重複は操作 ID と正規化タイトルで防ぐ。意味上の類似や別クライアントとの同時送信までは判定しない。送信結果が不明な操作は自動再送しない。課題の自動継続先は、人間が承認したローカル課題 ID に限る。
- 旧状態の取り込みは参照用アーカイブ。旧 DB や成果物の原本は停止後に別途バックアップする。旧所有権、実行中ジョブ、wake を自動で引き継がない。排他は共有ロックに従うローカルクライアントが対象。
- 通知されたトークン数は料金やサービス内部の往復回数を表さない。予算は次のターンの開始時に適用し、サービス側のハードキャップではない。

## 検証

- Apple Silicon、Codex CLI 0.172.0、既存 ChatGPT 購読で、実計算と成果物を伴う実験 2 件を実行。最終試験での待機は 6.41 秒と 5.93 秒。各実験で追加ターン要求 0 件、観測トークン増分 0、同一スレッドの再開各 1 回。標準出力と成果物のチェックサムは `332833500`。依存課題の完了まで全体で 4 ターン、観測累計は 198,508。App Server 再起動後も同一 ID を確認。
- 最初の実機試験では Homebrew Python の起動拒否とトークン予算による停止を観測した。Apple 付属 Python も Xcode のキャッシュ作成を拒否されたため、固定した Python 本体と標準ライブラリを実験プロファイルから読み取る構成に変更した。作業領域外の読み取り、Coordinator 相当の書き込み、Developer 相当の作業領域内書き込みを合成ファイルで照合した。
- 統合試験では停止、利用枠、障害復旧、二つの役割の同時稼働、ロール重複防止、クライアントの再接続、GitHub の承認と不確定配送、旧 SQLite 所有権の保護を検証。公式 REST で Issue #28 と依存関係を読み取り、AppKit の起動と画面描画を確認した。GitHub の実書き込み、旧実データ移行、GUI での実運用の通し試験は未実施。

- 分離チェックアウトでは Desktop 16 件、上流テンプレート 25 件、Copier 9.19.1 の配布・更新 2 件が通過。isekai-sim の旧運用回帰は 24 件が通過。

```sh
python3 -m unittest discover -s tests/adf -v
python3 -m unittest discover -s agents/tools/tests
PYTHONPATH=. python3 tests/adf/live_research.py
```
