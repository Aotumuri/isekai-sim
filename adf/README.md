# ADF デスクトップ版

ADF はローカルの Codex を起動し、Coordinator と Developer の対話、実験、停止と再開を管理する。画面、監督デーモン、Codex は別プロセスで動く。

## インストールと起動

macOS に Python 3.12 以上、Xcode Command Line Tools、公式 Codex CLI 0.172.0、Git を用意する。GitHub 一覧を使う場合は `gh` と既存の認証が必要。CLI は開発中も `python3 -m adf` から起動できる。GUI は下の手順でビルドする。ADF 自体を含むリポジトリを管理する場合は、アプリをそのリポジトリの外に配置する。

```sh
bash adf/macos/build-app.sh "$HOME/Applications/ADF.app" /path/to/python3
open "$HOME/Applications/ADF.app"
"$HOME/Applications/ADF.app/Contents/MacOS/adf" status
```

ビルドスクリプトは既存のアプリを上書きしない。更新時は両ロールを停止し、別の出力先にビルドして起動する。状態はアプリと独立した `~/Library/Application Support/ADF` にある。サインインは公式 Codex で行い、ADF は既存の ChatGPT 認証を確認する。追加クレジットが利用可能と報告されたアカウント、有効な購読枠が取得できないアカウント、個人プラン以外はターンを開始しない。当該リクエストの正確な課金額や、開始後に他のクライアントが消費した枠は ADF から確定できない。

## 操作

1. 「登録」で Git 作業ディレクトリと任意の GitHub リポジトリ名を指定する。
2. 「エージェント」でロールを選び、メッセージを入力して「開始 / 送信」を押す。進行中のターンへのメッセージは Codex の `turn/steer` で送る。
3. 「設定」でモデル、推論設定、追加指示、トークン予算、利用枠の回復方式を保存する。空のモデルと推論設定は Codex の既定値を使う。追加ロールの書き込み権限は Coordinator と同じ読み取り専用。
4. 実験を許可するには「実験」でテンプレート名、引数配列、上限時間を登録する。Developer ロールで「許可する実験」からその名前を選び、メッセージを送信する。最新のコミットからスナップショットを作る。元の作業ツリーやローカルの `node_modules` は実験に渡らない。
5. 実験の出力は一覧から該当実験を選んで確認する。「履歴と利用量」はターン要求の累計、通知されたトークン、明示的に取得した購読枠を表示する。トークン予算は次のターンの開始を抑止する目安で、サービス側のハードキャップではない。
6. 停止はロール単位で実行する。穏やかな停止は進行中のターンと実験を区切りまで待ち、次のターンを開始しない。即時停止はターンと ADF 管理下の実験を中断する。「再開」は保存したスレッドを開き、リポジトリの同一性と HEAD・インデックスを確認したうえで続行する。
7. ウィンドウを閉じると、すべてのロールを安全に停止するか、監督をバックグラウンドに残すか選べる。前者は停止受付後に画面を閉じ、監督は実行が区切りに達してから終了する。後者では再起動した画面が同じ監督に接続する。

### CLI

アプリのバンドル内にある `adf` コマンドと `python3 -m adf` は同じ操作を受け付ける。

```sh
python3 -m adf register /path/to/project --github owner/repo
python3 -m adf template 1 trial '["/bin/sleep","35"]' --timeout 46
python3 -m adf send 1 coordinator '研究案を検討したい'
python3 -m adf send 1 developer --experiment trial 'trial を開始し、結果を評価してください'
python3 -m adf status 1
python3 -m adf log JOB_ID
python3 -m adf stop 1 developer --immediate
python3 -m adf resume 1 developer '中断した実験の結果を確認してください'
python3 -m adf shutdown
```

## 障害復旧とデータ

- 打ち切られた実験・ターンと送信が確認できない継続は、監督の再起動時に `interrupted` として記録する。ロールを選び、履歴、実験、現在のファイルを確認して明示的に再開する。古い実験完了によるターンは自動送信しない。
- 状態・実験出力・会話はユーザー専用ディレクトリに保存する。DB は送り先を持つローカル操作用であり、バックアップは監督を停止してから行う。認証情報は公式クライアントに残す。指示や実験ログに秘密を入れない。ログの内容自体を検査して秘密を自動除去する機能はない。
- アーカイブは一覧から登録を外す操作。ファイルや履歴は削除されない。同じディレクトリを登録し直せる。ディレクトリを移した後の登録・スレッド移行は未実装。
- 既存の isekai-sim の Issue、研究報告、Developer チェックポイントは元のリポジトリに残る。既存の Developer を停止して旧 CLI の所有権を解放してから、ADF の Developer を使う。既存の Codex セッションや旧 Runner の実験を ADF が自動取得する機能はない。
- サンドボックスが Git メタデータへの書き込みを拒否する場合、ADF の Developer はコミットできない。現在の版は権限拡張を拒否するため、検証後に所有者がローカルでコミットする。
- スナップショットは Git の通常ファイルに対応し、サブモジュールとシンボリックリンクを含む場合は実験を失敗として記録する。上限は 1 万ファイル、128 MiB。実験出力は最大 256 KiB、継続に渡す末尾は最大 2 KiB。実験コマンド自身の成果物はスナップショット内に残る。
- 利用枠の自動回復は、公式状態で枯渇した枠とリセット時刻を取得できた場合にのみ、リセット後に一度確認する。回復が確認できなければ明示的な再開を待つ。

[設計判断と受け入れ試験](DESIGN.md)

## 自律研究

「研究」で課題名、受け入れ条件、優先度、依存先を登録する。「承認範囲で開始」で対象課題、研究範囲、実験数、時間、ターン、観測トークンの上限を確認する。Developer はその範囲で Python 実験を設計できる。検証結果を返した課題に続いて、依存を満たした承認済み課題へ進む。根拠付き判断や実験が返らない場合は停止する。

```sh
python3 -m adf task 1 '基準値を測定' '同じ条件で 2 回計算し、結果を比較する' --priority 1
python3 -m adf task 1 '再現条件を整理' '測定結果と再現条件を記録する' --depends-on 1
python3 -m adf research-start 1 '対象は測定と手順の記録' 1 2 --jobs 2 --timeout 60 --turns 4 --tokens 250000
python3 -m adf artifacts JOB_ID
python3 -m adf artifacts JOB_ID result.txt --offset 0 --size 4096
python3 -m adf research-resume 1
```

保留中の課題は `task-reopen PROJECT TASK 新しい受け入れ条件` で再登録できる。停止後の再開は既存の承認範囲と予算を維持する。中断した実験の結果が不明な場合は、履歴を確認して新規実行として承認する。以前の Desktop Developer スレッドは、最初の自律研究開始時に新しい公式ツールを備えたスレッドへ移る。旧 ID は履歴に残る。

## GitHub Issues の承認

中央の操作ポリシーは既定で空。登録先に `agents/config.toml` があれば、そのリポジトリの許可も照合する。「承認待ち」で対象と正確な入力を確認し、「GitHub に送信」を選んだ操作だけを既存の GitHub CLI で送る。通信障害などで結果が不明な操作は GitHub 上の実際の状態を確認する。

```sh
python3 -m adf tracker-policy 1 proposal comment progress checklist depends label complete
python3 -m adf tracker-issue 1 123
python3 -m adf tracker-draft 1 proposal '{"title":"仮説","body":"- [ ] 対照群を測定","priority":"P2"}'
python3 -m adf tracker-review OPERATION_ID --approve
```

操作の入力は `proposal` が `title/body/priority`、`comment` が `issue/body`、`progress` が `issue/status/priority`、`depends` が `issue/blocked_by`、`label` が `issue/name/enabled`、`checklist` が `issue/criterion/checked`、`complete` が `issue`。ラベルは既存の GitHub ラベルを使う。`--decline` で却下できる。

## 旧 ADF の取り込み

旧 Developer を停止して所有権を解放し、ジョブの終了を確認する。停止中に旧 `agents/runtime/` と研究記録を別の保管場所へバックアップする。`legacy-preview PROJECT` で JSON または SQLite の所有者、チェックポイントと実験履歴を確認する。`legacy-import PROJECT DIGEST` は確認した内容が変わっていない場合に、Desktop の私有領域に整合性検証済みの参照用スナップショットを作る。旧結果を参照し、必要な課題を新たに登録する。

[統合方針と今回の実測](PRODUCTION.md)

## 現行の実運用手順

GitHub の課題選択、操作別承認、オフライン実験環境、未コミットファイルの固定、差分確認と利用量内訳は[実運用手順](OPERATING_RESEARCH.md)を参照。
