# 戦争AIの評価記録

状態：軍事基準200件を測定済み。全システム基準測定中。新旧比較・改善実証は未完了。

## 基準

- ソース：`394d4bd`。
- `npm test`：629 / 629 成功。
- `npm run build`：成功。既存の大きい生成バンドルの警告あり。
- `npm run benchmark:quick -- --output diagnostics/war-ai-baseline-quick.json`：成功。
- UI確認：未実施。現段階ではUI変更なし。

## 再現する測定

```sh
node --import tsx test/diagnostics/war-ai-matrix.ts --seeds 20 --ticks 3200 --output diagnostics/war-ai-baseline-development.json
```

10シナリオ × 20シード。開発用は 822748319780–822748319799。
未使用評価用は `--partition holdout` で 922748319780–922748319799。
640×360、quick世界、3200 fast tick、throughput、既存予備・再編成・
突破追撃・包囲縮小を有効化。固定入力の構築と実行は既存ベンチマークを再利用する。
各行の完了後にJSONを保存し、同じコマンドで再開できる。
ソース未コミット時や異なるリビジョン・条件の出力への追記は拒否する。
失敗シードも記録し、無言で除外しない。

対象は active-war、long-frontline、stalemate-breaker、collapse-advance、
capital-threat、retreat-heavy、reorganization-heavy、two-island-amphibious、
late-game、base-world。名称だけで条件成立を保証しない。

出力には開始・終了世界、作戦成功・失敗・中止、移動や配分の既存カウンタ、
膠着、資源、首都陥落・国家消滅、CPU時間、ヒープ、最大RSS等を保存する。
最大RSSはプロセスの高水位なので、各行に独立したメモリ消費量ではない。
CPU・所要時間は実行負荷とJITの影響があり、最終A/Bでは順序と反復も検討する。

## 現時点の制約と残作業

標準ベンチマークの `createSeededWorld` は外交・動員・研究・援助・貿易を
無効化する。強制戦争は `isTest` であり、既存のcampaign目的・期限も
適用されない。この行列は軍事機構の基準であって、外交、和平、通常自律
シミュレーションの評価を代替しない。base-world でも旧式宣戦は有効であり、
無戦争の対照群ではない。通常プレイの外交モードとも異なる。

全システムを有効にする測定は次の通り（強制戦争シナリオでは既存の
isTest 属性を維持する。外交開戦は base-world で別に確認する）。

```sh
node --import tsx test/diagnostics/war-ai-matrix.ts --seeds 20 --ticks 10000 --full-systems --output diagnostics/war-ai-baseline-full-development.json
node --import tsx test/diagnostics/war-ai-report.ts diagnostics/war-ai-baseline-development.json
```

## 軍事基準の実測値

200 / 200 件成功、シナリオ構築・実行の例外なし。
3200 fast tick の全体所要時間中央値と、各指標のシード平均を示す。
作戦中止をすべて無意味な中止とみなしてはいけない。終戦や緊急防衛も含む。

|シナリオ|時間中央値 ms|作戦作成|作戦完了|作戦中止|首都陥落|
|---|---:|---:|---:|---:|---:|
|active-war|593|20.10|10.20|7.70|4.55|
|long-frontline|773|3.95|1.80|1.85|1.30|
|stalemate-breaker|524|6.15|1.95|2.60|0.80|
|collapse-advance|359|1.35|1.05|0.20|0.85|
|capital-threat|504|3.15|1.65|1.35|1.75|
|retreat-heavy|541|12.55|7.35|4.85|4.60|
|reorganization-heavy|610|21.30|11.05|8.25|5.30|
|two-island-amphibious|531|5.80|2.25|3.35|0.45|
|late-game|904|28.45|12.45|12.55|4.85|
|base-world|524|17.70|9.75|7.20|5.35|

分布（中央値、平均、最小、最大、p95）は `war-ai-baseline-summary.json`。
終戦後の区間も全体時間に含むため、速度改善を単純にAI計算効率の改善と
解釈できない。戦争期間中の負荷と終戦時刻を追加観測する必要がある。

さらに必要なもの：

- 外交・経済・動員を有効にした長期自律世界。
- 均衡・戦力差・資源制約について、開始時条件が実際に成立する検査。
- 戦争開始・終了、目的達成時刻、利益と費用の時系列計測。
- 国家戦略の変更回数・理由と作戦への寄与の観測。
- 同一戦闘ルール・同一初期条件での新旧A/B。
- シナリオ別の平均、中央値、分布、最悪例、未使用シード評価。
- 新戦略の決定性、無効命令、終戦・国家消滅・戦線消失、直接命令、
  緊急防衛、計画安定性、長時間負荷の専用テスト。

基準テスト成功を戦略品質の改善と解釈しない。現段階で改善率や
新AIの完成を主張できる結果はない。
