# ADF Desktop 信頼性と受け入れ

## 優先した修正

- **チェックリストの整合性。** 送信経路がチェックリストの照合処理を呼ばず、ADF 自身の更新が次回に外部変更と判定されていた。送信前に期待する更新後の fingerprint を SQLite に保存し、API の後に取り直した値が一致した場合だけ、操作の確定と研究側の fingerprint を同じトランザクションで更新する。停止後に届いた結果は該当する旧実行にのみ記録し、推論を始めない。コミット相当の条件付き Issue 更新を GitHub API は文書化していないため、送信直前・送信直後の照合を行う。別クライアントとの同時編集には競合の余地がある。 [GitHub Issues API](https://docs.github.com/en/rest/issues/issues)
- **承認と復旧。** 停止・異常終了などで実行世代が変わると未送信の承認は失効する。明示的な再開で必要な承認を新しく発行する。送信済みで結果不明のチェックリスト・進捗・完了が残る Issue は、読み取り照合まで再送と研究の継続を止める。確定済みの完了からは、明示的な再開で次の課題を選択する。
- **実験証拠。** HEAD、承認済みファイル、終了コード、成果物に加え、依存の指紋、ランタイム、実行引数、時間制限を照合する。採取時の SHA-256 は保管し、完了判定では依存ファイルのサイズ・inode・mtime・ctime・モードを走査する。依存内容の総再読み取りは行わない。環境を変えた場合や新しい記録項目を持たない旧実験には、新しい試験を要求する。Python 標準ライブラリ全体や OS の共有ライブラリは照合対象外。

## 割り込みと復旧の操作

1. **承認待ちを停止した場合**は「研究を再開」を押す。古い ID は使えず、新たな承認が必要になる。再開の直前に Issue の本文・担当・依存を確認する。
2. **操作結果が不明な場合**は「GitHub Issues」→「結果照合」を使う。進捗ラベルが部分的に反映されている場合は、専用テスト Issue 上で手動で目的の状態に揃えてから読み取り照合する。ADF は同じ操作を自動送信しない。
3. **チェックリストの更新と第三者編集が重なった場合**は、GitHub で実際の本文とチェック状態を読む。要求したチェック状態が確認できた場合に限り、`adf tracker-reconcile OPERATION_ID --accept-external-edit` で配送結果を確定できる。この操作で古い研究条件は更新されない。変更を評価したうえで `adf research-resume PROJECT --accept-issue-changes` を実行する。変更前の受け入れ証拠は再利用しない。着手前の Issue が変わった場合は、更新された課題に対して開始からやり直す。
4. **利用枠で停止した場合**は、枠が回復してから「研究を再開」。着手確認済みの Issue に対して着手操作を繰り返さない。

## 容量と権限

計測対象のホストの依存は 2,872 ファイル、ディスク使用量は約 75 MiB。分離用に npm キャッシュから既存の tsx 4.21.0 とその推移依存を通常ファイルとして用意した試験環境は、2,946 ファイル・92,106,415 バイト。メタデータ照合は 0.043 秒だった。元のツリーにある tsx の外部シンボリックリンクは、そのままでは受け付けない。分離環境で実際のシミュレーション回帰は 4 件とも成功した。終了時点の RSS は約 273 MiB、V8 の使用ヒープは約 67 MiB。ピーク値やプロセスツリー全体の使用量ではない。

この回帰には依存上限 256 MiB・20,000 ファイルと Node の old-space 256 MiB で足りた。未コミット入力は未作成の予定ファイルを含めて先に指定できる。今回の試験で使った入力は 1 ファイルで、30 ファイル・16 MiB を緩和する測定根拠は得られていない。新規ファイルの予定が変わった場合は停止して承認範囲を設定し直す。ディレクトリ全体を無条件に取り込む方式は採用していない。大規模な長期シミュレーションでの上限は未測定。

macOS の setrlimit は CPU やファイルサイズをプロセス単位で制限できる。APFS ボリュームのクォータや Virtualization フレームワークの VM 単位の制限は、本アプリへ新しいストレージ運用や実行境界を追加する。今回の変更では、既存の壁時計上限、コピー上限、空き容量確認を維持した。プロセスツリー全体の RSS、CPU、実行中の総ディスク使用量に対する厳密な上限はない。 [Apple setrlimit](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setrlimit.2.html) · [Apple APFS クォータ](https://support.apple.com/en-ie/guide/disk-utility/dskua9e6a110/mac) · [Apple Virtualization](https://developer.apple.com/documentation/virtualization)

公式 Codex App Server にはコマンド単位の承認機構がある。Desktop は .git の保護と現在の権限方針を維持する。Git コマンドの承認だけでは、保護を残したまま既存ステージ、フック、設定による影響を隔離できる構成を確認できなかった。引き続き「差分確認」と人間によるコミットを使う。 [Codex App Server の承認](https://learn.chatgpt.com/docs/app-server#approvals) · [Codex 権限](https://learn.chatgpt.com/docs/permissions)

## 検証済み範囲と運用判断

実機 Codex 0.172.0 と Node 24.22.1 で、使い捨てプロジェクトを登録し、Coordinator の独立した待機セッションを保持しながら、Developer が未コミットの試験スクリプトを作成した。分離環境で実シミュレーション回帰 4 件、成果物 simulation.json、完了検証に成功。初回ターン終了から実験完了まで 18.44 秒、追加ターン要求 0 件、観測トークン増分 0、同一 Developer スレッドへの再開 1 回、合計 2 ターン。Coordinator の実推論はこの試験では起動していない。

Desktop 回帰 30 件と旧運用回帰 24 件が通過。GitHub の優先度・依存順の選択、複数課題継続、チェックリストと完了、部分成功と障害後の照合、停止と承認の失効、利用枠後の再開と重複防止は模擬試験で確認した。ネイティブ GUI は起動・描画を確認。実 GitHub 書き込み、GUI 経由の停止・再接続の通し操作、実機で両ロールが同時に推論するケースは未確認。ローカル課題や監督者付きの限定試験運用は可能。GitHub 書き込みを伴う無人本番運用は、専用 Issue と手動手順での確認後に判断する。

## ADF.app での手動受け入れ

1. リポジトリ直下から `PYTHONPATH=. python3 tests/adf/live_isekai.py --prepare /tmp/adf-gui-fixture` を実行する。未作成のパスを使う。既存の npm 依存を参照するため、開発用の node_modules が必要。
2. ADF.app の「プロジェクト」→「登録」でそのフォルダを選ぶ。最初は GitHub を未登録にしてローカル課題方式を使う。「研究」で課題を一件追加し、実験ログと simulation.json の確認を受け入れ条件にする。
3. Coordinator と Developer のロールを選び、Coordinator に試験の観点整理を依頼する。研究開始で対象課題を選び、実験 1 件、40 秒、2 ターンを指定する。実験環境は node、作業ファイルは adf-acceptance.mjs、依存は node_modules、必須成果物は simulation.json。研究範囲には「このスクリプトを adf_research_experiment の script 指定で実行し、開始後はターンを終え、結果後に完了判定を返す」と入力する。
4. 「実験」で成功ログの 4 件と simulation.json を確認する。「履歴と利用量」で初回・再開の 2 ターンを照合する。別のローカル課題で実験待機中に GUI から停止し、完了後に自動再開しないことを確認する。
5. 別の実行中にウィンドウを閉じて「バックグラウンドで継続」を選ぶ。再度 ADF.app を開き、同じプロジェクト、実験 ID、セッションが表示されることを確認する。最後は「安全に停止」を選ぶ。
6. GitHub 書き込みを検証する場合は、担当者の承認を得た専用テスト Issue のみを使う。順次チェック、停止中の旧承認、結果照合、依存課題への移行を確認する。本番の Issue 番号は実行範囲へ入れない。

```sh
python3 -m unittest discover -s tests/adf
python3 -m unittest discover -s agents/tools/tests
PYTHONPATH=. python3 tests/adf/live_isekai.py
PYTHONPATH=. python3 tests/adf/live_isekai.py --turns
```
