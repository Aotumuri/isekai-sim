# 国家戦略AIの評価

実験機能 `warCampaignEnabled` の採用判断を記録する文書。
実装・責任分担は [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md)、
棄却した案と測定当時の制約は [AI_EXPERIMENT_HISTORY.md](AI_EXPERIMENT_HISTORY.md) を参照。

## 比較条件

基準mainは `394d4bd`。試作5は `b19b2bb`。試作6は `1f16d9e`。試作7は和平の最短時刻と目的確保方針の接続を検証する。
新旧の戦闘、降伏、生産単価・収入、動員上限、同時攻勢上限は同じ。
試作1〜4の測定後、初回未使用群の結果を読む前の静的監査で終結方針の
迂回を発見し修正した。その群は試作4の資料として保存し、最終群に再利用しない。

|群|固定シード|用途|
|---|---|---|
|開発|822748319780〜799|設計・反復比較、各20シード|
|試作4の初回未使用群|922748319780〜799|旧試作の記録。試作5の採用判断に使わない|
|試作5の未使用群|922748320780〜799|試作5の比較。結果・残課題は実験経過に保存|
|試作6の未使用群|922748321780〜799|目的承認修正の比較と原因調査|
|試作7の未使用群|922748322780〜799|最終比較、各20シード。結果に合わせた追加調整をしない|

各群は13シナリオ×20シード×新旧2群、10000 fast tick（仮想1000秒）。
640×360 quick世界。外交、動員、研究、援助、貿易、政治変動を両群で有効にし、
設定の実値を保存する。事前の強制戦争も通常戦争属性に揃える。
軍事専用条件や政治変動なしの古い比較とは混ぜない。

対象は active-war、long-frontline、stalemate-breaker、collapse-advance、capital-threat、
retreat-heavy、reorganization-heavy、two-island-amphibious、late-game、base-world、
matched-war、unequal-war、economic-constraint。
均衡・戦力差は初期構成を20対20・20対10に揃えた専用シナリオでも測り、
資源制約は両国の初期補充・燃料・鋼材在庫を0にして再現する。収入は変えない。
base-world は初期戦争なしで外交による開戦から観測する。

## 指標の意味と限界

- **目的**：両群共通の開戦時代理目標を固定する。攻撃側は当初要求、国境地域、
  国境がなければ相手首都。防御側は開戦時の全自領。最初の達成と終結・打切時の
  保持を区別する。これは内部目標の妥当性そのものを証明しない。特に海上の港目標と異なる。
- **領土価値**：開戦時の人口・施設・資源の基礎価値を固定し、条約後の他国領獲得と
  自領喪失を測る。一時占領だけを利得としない。開戦時国土価値で正規化する。
  両陣営の平均は国力差による再分配にも左右され、総合的な賢さの単独指標にしない。
- **費用・存続**：開戦時の同じ戦争集合について損耗・生存率を報告する。
  全戦争の集計は、自発的な開戦数や相手が異なり得るので別に扱う。
- **継続性**：戦略変更と理由、戦線間移動、作戦中止理由。終戦・救援・費用超過による
  正当な中止まで失敗扱いしない。移動は配分先変更の代理指標であり、実移動距離や
  無意味さを直接測る値ではない。生件数と戦争側の活動時間あたりの値を併記する。
- **進行**：終戦時間、観測終了時の未終結、膠着・戦線変動。未終結は右打切り。
  終了戦争だけの平均に加え、未終了を観測上限に置く時間も示す。
- **分布**：各条件の平均・中央値・最小・最大・p95と、同じシードの対応差を保存する。
  少数サンプルの差を統計的確証とは呼ばず、合成点で悪化を隠さない。

切替は世界の全国家に同時に行う。防御側の改善には攻撃側の方針変更も影響するため、
防衛戦術そのものが強くなったという因果や、一対一の新旧対戦勝率を示す実験ではない。

同じ初期シードでも生産・外交の経過と乱数呼出し順は後に分岐する。後続戦争の
集計差を特定の一判断の単独因果と解釈しない。固定の開戦集合と全戦争を分ける
理由でもある。

観測は任意の診断コールバックで行う。人口の遅延初期化を誘発せず、観測あり・なしの
終了状態一致を回帰テストで検査する。初期基準200件でも観測追加前後のゲーム状態が
全件一致した。CPU・壁時計・heapはこの状態一致の比較から除く。

## 再現手順

```sh
npm test
npm run build
npm run benchmark:quick

SCENARIOS=active-war,long-frontline,stalemate-breaker,collapse-advance,capital-threat,retreat-heavy,reorganization-heavy,two-island-amphibious,late-game,base-world,matched-war,unequal-war,economic-constraint
node --import tsx test/diagnostics/war-ai-matrix.ts --seeds 20 --ticks 10000 --full-systems --political-turbulence --normal-wars --observe-wars --scenarios "$SCENARIOS" --output diagnostics/war-ai-v6-control-development.json.gz
node --import tsx test/diagnostics/war-ai-matrix.ts --campaign --seeds 20 --ticks 10000 --full-systems --political-turbulence --normal-wars --observe-wars --scenarios "$SCENARIOS" --output diagnostics/war-ai-v6-development.json.gz
```

未使用群は両コマンドに `--partition holdout --seed-offset 2000` を付け、出力名を
`war-ai-v6-control-holdout.json.gz` / `war-ai-v6-holdout.json.gz` に変える。
比較は `war-ai-report.ts <旧群> <新群>`。JSON・gzipのどちらも読める。
ソース未保存・異なる条件への追記・比較ペアの不足を拒否し、一件ごとに原子的に保存する。
再実行時は出力のリビジョンも一致する必要があるため、別のコミットでは新しい出力名を使う。

## 長時間・性能・上陸・表示

```sh
node --expose-gc --import tsx test/diagnostics/war-ai-soak.ts --ticks 100000 --seeds 3 --political-turbulence --output diagnostics/war-ai-soak-app-v6.json
node --expose-gc --import tsx test/diagnostics/war-ai-scale.ts --default-map --ticks 2000 --seeds 2 --output diagnostics/war-ai-default-scale-v6.json
node --import tsx test/diagnostics/war-ai-amphibious.ts --seeds 20 --ticks 10000 --output diagnostics/war-ai-amphibious-v5.json
```

長時間検証は通常自律世界3シードを両群で100000tick（仮想10000秒）動かす。
10000tickごとのGC後保持heap、CPU、RSS、計画数・履歴上限、地域・兵力の妥当性を
検査する。GC時間は計測区間外。既定マップは320000 micro regionを使い、生成を
含む時間と実行だけの時間を分ける。品質評価の20シードとは別の少数性能確認。
並列行列の壁時計は競合・JIT・戦争経過の影響を受けるため、速度改善の根拠にしない。

上陸診断は2シナリオ×20シード×軍事専用/通常設定×新旧で、既存の予測式を変えずに
予測余裕、実際の戦争存続、出航、上陸、取消を保存する。却下案の反実仮想の成功は
シミュレートしていない。終戦まで時間が残っただけで「誤って却下した」とは分類しない。
同一需要の再試行は独立標本ではない。seed単位で併せて読む。

表示は既存デバッグUIを使う専用画面 `test/diagnostics/war-ai-preview.html` で確認した。
方針、主敵、目標、理由、作戦段階と終結結果が描画され、30秒進める操作で更新された。
上部ボタンとの重なりを修正済み。画像は `diagnostics/war-ai-preview.jpg`。
通常プレイの全面的なUI検証は行っていない。lintコマンドはリポジトリに定義がない。

試作6の長時間検証は全6件が完了。終盤GC後の保持heapは38.09〜42.82MiB。
新群の計画数は最大4、目標6、変更履歴51、終結履歴30。不変条件違反はなく、
最後の5区間のheapは各回ともほぼ横ばい。漏れが皆無という証明ではない。
全例で終了時の戦争数は0だった。

|seed末尾|CPU合計 ms 旧→新|終了時部隊数 旧→新|
|---|---:|---:|
|780|35934→55882|44→53|
|781|53518→72910|54→120|
|782|28045→58858|25→45|

CPU費用は全3例で増加した。部隊数や自律戦争の経過が異なり、並列実験と同時に
測ったため、固有の戦略層の計算費用と世界経過の費用を分離できない。
これを高速化や費用増のない改善とは扱わない。既定マップの最終確認は他の
実験が完走してから独立して実行する。

試作5の上陸予測診断は160件完走。通常設定の結果を示す（件数は作戦試行単位で、増援も含む）。

|条件（各20seed）|作成 旧→新|出航|上陸完了|橋頭堡成功|実終戦が予測完了より早い件数|
|---|---:|---:|---:|---:|---:|
|active-war|6→6|6→6|3→2|0→1|3→4|
|two-island-amphibious|92→101|92→101|37→31|27→25|10→21|

到着成功例だけの時刻誤差中央値は全条件0tickだが、成功例の選択による偏りがある。
航行時間の推定と、戦争自体の存続見込みを区別する必要がある。後者は依然楽観的な
事例があり、通常二島の輸送損失も42→51件と増加した。新機能による海上品質改善を
実証したとは主張しない。却下案の反実仮想は未測定。全件は
`war-ai-amphibious-v5.json.gz`、集計は `war-ai-amphibious-v5-summary.json`。
コマンドは非圧縮JSONを生成し、保存時にgzipへ圧縮した。

## 最終比較

試作5・6の全件と悪化は実験経過に記録した。試作7では、目的達成による抑制と
食料・許容損耗による抑制を分け、前者だけは最短の自動和平時刻まで軍事的な
出口を残す。既存の30秒/90秒の受諾規則を同じ純粋関数へ抽出して両方から使う。
戦闘・生産・開戦条件・同時作戦上限・受諾スコア・受諾時刻は変えない。
開発・未使用とも新旧20seed×13条件、政治変動込み10000tickで再測定する。
未使用は `--seed-offset 3000`。利得・保持・損耗・配分変更・未終結・分布を全条件で
報告する。この結果に合わせた追加調整はせず、未達が残れば既定無効の研究成果として
まとめる。内部目標の追跡も同じ開発3条件で繰り返す。

内部目標の再追跡は次で実行する。旧AIとの共通代理目標評価とは分ける。

```sh
node --import tsx test/diagnostics/war-ai-intent-audit.ts --seeds 20 --ticks 10000 --output diagnostics/war-ai-intent-v6.json
node --import tsx test/diagnostics/war-ai-validate.ts diagnostics/war-ai-v6-control-development.json.gz diagnostics/war-ai-v6-development.json.gz diagnostics/war-ai-app-control-development.json.gz
```

## 成果物の対応

|内容|保存先（diagnostics/以下）|
|---|---|
|試作6の開発A/B|`war-ai-v6-control-development.json.gz`, `war-ai-v6-development.json.gz`|
|試作6の未使用A/B|`war-ai-v6-control-holdout.json.gz`, `war-ai-v6-holdout.json.gz`|
|全指標の分布・対応差|`war-ai-v6-development-comparison.json.gz`, `war-ai-v6-holdout-comparison.json.gz`|
|比較条件・無効時互換性|`war-ai-v6-development-validation.json`, `war-ai-v6-holdout-validation.json`|
|長時間・GC後メモリ|`war-ai-soak-app-v6.json`|
|既定マップ性能|`war-ai-default-scale-v6.json.gz`|
|上陸予測の実測|`war-ai-amphibious-v5.json.gz`, `war-ai-amphibious-v5-summary.json`|
|内部目標の追跡|`war-ai-intent-v6.json.gz`|
|表示確認|`war-ai-preview.jpg`|

大きな生成レポートはレビュー時にソース差分を埋めないようgzipで保存する。
行列はgzipを直接出力し、他の診断の非圧縮JSONは保存後にgzipへ変換する。
