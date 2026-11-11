# 国家戦略AIの評価

実験機能 `warCampaignEnabled` の採用判断を記録する文書。
実装・責任分担は [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md)、
棄却した案と測定当時の制約は [AI_EXPERIMENT_HISTORY.md](AI_EXPERIMENT_HISTORY.md) を参照。

## 比較条件

基準mainは `394d4bd`。試作5は `b19b2bb`。試作6は `1f16d9e`。試作7は `93ba1cf` で固定し、和平の最短時刻と目的確保方針の接続を検証した。
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
node --import tsx test/diagnostics/war-ai-matrix.ts --seeds 20 --ticks 10000 --full-systems --political-turbulence --normal-wars --observe-wars --scenarios "$SCENARIOS" --output diagnostics/war-ai-v7-control-development.json.gz
node --import tsx test/diagnostics/war-ai-matrix.ts --campaign --seeds 20 --ticks 10000 --full-systems --political-turbulence --normal-wars --observe-wars --scenarios "$SCENARIOS" --output diagnostics/war-ai-v7-development.json.gz
```

未使用群は両コマンドに `--partition holdout --seed-offset 3000` を付け、出力名を
`war-ai-v7-control-holdout.json.gz` / `war-ai-v7-holdout.json.gz` に変える。
比較は `war-ai-report.ts <旧群> <新群>`。JSON・gzipのどちらも読める。
ソース未保存・異なる条件への追記・比較ペアの不足を拒否し、一件ごとに原子的に保存する。
再実行時は出力のリビジョンも一致する必要があるため、別のコミットでは新しい出力名を使う。

現行実装の回帰テストは669/669成功、ビルドと短時間ベンチマークも成功。
共有した和平成熟条件、時刻だけが変わるキャッシュ更新、資源制約、プレイヤー命令、
国家消滅・戦線消失・戦争終了、輸送兵員の保護、決定性と観測の非干渉を検査する。

## 長時間・性能・上陸・表示

```sh
node --expose-gc --import tsx test/diagnostics/war-ai-soak.ts --ticks 100000 --seeds 3 --political-turbulence --output diagnostics/war-ai-soak-app-v7.json
node --expose-gc --import tsx test/diagnostics/war-ai-scale.ts --default-map --ticks 2000 --seeds 2 --output diagnostics/war-ai-default-scale-v7.json
node --import tsx test/diagnostics/war-ai-amphibious.ts --seeds 20 --ticks 10000 --output diagnostics/war-ai-amphibious-v7.json
```

長時間検証は通常自律世界3シードを両群で100000tick（仮想10000秒）動かす。
10000tickごとのGC後保持heap、CPU、RSS、計画数・履歴上限、地域・兵力の妥当性を
検査する。GC時間は計測区間外。既定マップは320000 micro regionを使い、生成を
含む時間と実行だけの時間を分ける。品質評価の20シードとは別の少数性能確認。
並列行列の壁時計は競合・JIT・戦争経過の影響を受けるため、速度改善の根拠にしない。
行列のheapは保存済み結果やGC時期も含み、maxRSSはプロセスの高水位。
保持メモリの評価には別のGC追跡と状態上限検査を使う。

上陸診断は2シナリオ×20シード×軍事専用/通常設定×新旧で、既存の予測式を変えずに
予測余裕、実際の戦争存続、出航、上陸、取消を保存する。却下案の反実仮想の成功は
シミュレートしていない。終戦まで時間が残っただけで「誤って却下した」とは分類しない。
同一需要の再試行は独立標本ではない。seed単位で併せて読む。

表示は既存デバッグUIを使う専用画面 `test/diagnostics/war-ai-preview.html` で確認した。
方針、主敵、目標、理由、作戦段階と終結結果が描画され、30秒進める操作で更新された。
上部ボタンとの重なりを修正済み。画像は `diagnostics/war-ai-preview.jpg`。
通常プレイの全面的なUI検証は行っていない。lintコマンドはリポジトリに定義がない。

試作7の長時間検証は全6件が完了。終盤GC後の保持heapは38.14〜43.09MiB。
新群の計画数は最大5、目標6、変更履歴120、終結履歴50。不変条件違反はない。
最後の5区間の保持heap増加は最大約1.47MiBで、時点間の段差もある。
状態の上限違反や大規模な継続増大は検出されないが、漏れが皆無という証明ではない。
全例で終了時の戦争数は0だった。

|seed末尾|CPU合計 ms 旧→新|終了時部隊数 旧→新|
|---|---:|---:|
|780|46833→88629|44→112|
|781|56071→47242|54→35|
|782|30853→48831|25→29|

CPU費用は増減が混在し、大きく増えた例も残る。部隊数や自律戦争の経過が異なり、
並列実験と同時に測ったため、固有の戦略層の計算費用と世界経過の費用を分離できない。
高速化や費用増のない改善とは扱わない。既定320000領域の確認は他の実験の完走後、
同一プロセス内で新旧の順を交互にして4件を独立実行した。2000tickの実行時間は
seed780で22399→16747ms、seed781で12810→15784ms。CPUは28495→18910ms、
14037→17717ms。JIT・世界経過に左右され、2seedから一律の速度優位を主張しない。

試作7の上陸予測診断は160件完走。通常設定の結果を示す（件数は作戦試行単位で、増援も含む）。

|条件（各20seed）|作成 旧→新|出航|上陸完了|橋頭堡成功|実終戦が予測完了より早い件数|
|---|---:|---:|---:|---:|---:|
|active-war|6→6|6→6|3→3|0→2|3→3|
|two-island-amphibious|92→101|92→101|37→31|27→25|10→21|

到着成功例だけの時刻誤差中央値は全条件0tickだが、成功例の選択による偏りがある。
航行時間の推定と、戦争自体の存続見込みを区別する必要がある。後者は依然楽観的な
事例があり、通常二島の輸送損失も42→51件と増加した。新機能による海上品質改善を
実証したとは主張しない。却下案の反実仮想は未測定。全件は
`war-ai-amphibious-v7.json.gz`、集計は `war-ai-amphibious-v7-summary.json`。
コマンドは非圧縮JSONを生成し、保存時にgzipへ圧縮した。

## 最終比較

全1040件が完走し、実行・構築例外は0。520対の実設定・開始集計が一致した。
無効群の開発260件は以前の旧AI基準とCPU以外の終了ゲーム状態・戦争結果が全件一致。
以下は最終未使用群の各20seedの対応差平均（新−旧）。保持・生存はポイント、価値は
開戦時自領価値で正規化した比。base-worldの初期戦争指標は対象なし。

|条件|攻撃目標 Δpp|防御自領 Δpp|攻撃価値比 Δ|防御価値比 Δ|生存 Δpp|
|---|---:|---:|---:|---:|---:|
|active-war|+1.00|-1.00|+0.061|-0.046|+2.37|
|long-frontline|-5.00|+0.00|-0.081|+0.097|+5.00|
|stalemate-breaker|+5.00|+5.00|-0.015|-0.005|-7.50|
|collapse-advance|+0.00|+0.00|+0.000|+0.000|+0.00|
|capital-threat|-5.00|+5.00|-0.043|+0.021|-2.50|
|retreat-heavy|+0.00|+0.00|+0.000|+0.000|+0.00|
|reorganization-heavy|-5.00|+0.00|+0.004|-0.021|+5.00|
|two-island-amphibious|+0.00|+0.00|+0.000|+0.000|+0.00|
|late-game|-5.22|+5.21|-0.030|+0.048|-0.43|
|base-world|—|—|—|—|—|
|matched-war|+0.00|+10.00|-0.074|+0.121|+0.00|
|unequal-war|-15.00|+15.00|-0.066|+0.093|+5.00|
|economic-constraint|+5.00|+10.00|+0.052|-0.120|+7.50|

頻度は配分先変更/1000戦争側tick。未終結と配分変更は後続の自発戦争も含む。

|条件|初期損耗 Δ|配分変更 Δ|頻度 Δ|未終結側 Δ|初期戦争期間 Δtick|
|---|---:|---:|---:|---:|---:|
|active-war|-3.77|-46.50|-5.15|+0.10|+25.67|
|long-frontline|+1.63|-8.35|-4.59|-0.30|+14.10|
|stalemate-breaker|-10.53|+38.00|+9.48|+0.00|-107.80|
|collapse-advance|-2.68|+22.95|+5.80|-0.20|-17.20|
|capital-threat|+7.12|-5.10|+0.40|+0.10|-74.30|
|retreat-heavy|+0.96|-50.45|-14.20|+0.10|+3.85|
|reorganization-heavy|-7.51|+8.00|+8.76|+0.50|-75.45|
|two-island-amphibious|-89.14|-1.10|-0.34|-0.10|-380.00|
|late-game|-1.85|+21.25|-0.29|+0.30|-22.87|
|base-world|—|+1.80|-2.85|+0.10|—|
|matched-war|-11.28|-7.10|-1.71|+0.40|-55.15|
|unequal-war|+0.39|+31.30|+2.59|+0.20|+4.80|
|economic-constraint|-1.26|-4.45|+0.02|+0.10|-3.00|

改善例はactive-warの初期損耗19.31→15.54、配分変更99.00→52.50。
均衡戦争は損耗163.18→151.90、防御側の自領保持50→60%、攻撃側は40%のまま。
一方、膠着の配分変更67.20→105.20、再編成の正規化頻度11.01→19.77など悪化もある。
active-warの配分変更差は平均−46.5でも中央値−6、範囲−419〜+206。
再編成の同差は中央値+2.5、範囲−300〜+221で、平均だけでは判断できない。
全条件の中央値・p95・最悪例・対応差は比較JSONに保存した。
base-worldの自発戦争数は平均5.65→5.35、戦争のある期間は1961.7→2058.45tick。
損耗低下を単に戦争回避の成功と数えず、上表の固定された当初戦争も併せて評価する。

**採用判断：既定では無効のまま。** 複数条件での改善はあるが、目標保持・損耗・
再配分・終結を総合した一貫した優越は実証できない。海上の政治的利得と期間予測、
移動と継戦の期待費用、複数国の和平調整、実際の観察の面白さは未達・未評価が残る。
本採用可能な完成版とは主張せず、実装・診断・反復結果をレビュー可能な研究成果とする。
結果を見て追加調整したり、新機能を既定で有効化したりしない。

原因確認の事後検証では、試作6の悪化例3件を固定した試作7で再実行した。
最終未使用群には含めない。首都危機seed922748321797の初期終戦は388→142tick、
長期戦線seed922748321792は910→510tickとなり、両方とも目標保持の結果は同じ。
均衡戦争の同seedは1010tickのままで、時間接続だけでは全ての悪化を解消しない。
データは `war-ai-v7-retrospective-capital.json.gz` と
`war-ai-v7-retrospective-long-war.json.gz`。これは選択済み事例の原因検証であり、
一般化した改善率の推定として使わない。

内部目標の開発追跡は60件完走。当初の限定目標の終結時確保はactive-warで36/100、
均衡戦争で10/20、二島で0/20。二島は一時達成9件を観測しても終結後の確保に至らない。
軍事目標と合法な政治的利得をさらに整合させる必要がある。この新群内の説明は
旧AIとの公平な比較の代わりにしない。実行方法は次の通り。

```sh
node --import tsx test/diagnostics/war-ai-intent-audit.ts --seeds 20 --ticks 10000 --output diagnostics/war-ai-intent-v7.json
node --import tsx test/diagnostics/war-ai-validate.ts diagnostics/war-ai-v7-control-development.json.gz diagnostics/war-ai-v7-development.json.gz diagnostics/war-ai-app-control-development.json.gz
```

## 成果物の対応

|内容|保存先（diagnostics/以下）|
|---|---|
|試作7の開発A/B|`war-ai-v7-control-development.json.gz`, `war-ai-v7-development.json.gz`|
|試作7の未使用A/B|`war-ai-v7-control-holdout.json.gz`, `war-ai-v7-holdout.json.gz`|
|時間接続の開発群差|`war-ai-v6-to-v7-development.json.gz`|
|全指標の分布・対応差|`war-ai-v7-development-comparison.json.gz`, `war-ai-v7-holdout-comparison.json.gz`|
|比較条件・無効時互換性|`war-ai-v7-development-validation.json`, `war-ai-v7-holdout-validation.json`|
|長時間・GC後メモリ|`war-ai-soak-app-v7.json`|
|既定マップ性能|`war-ai-default-scale-v7.json.gz`|
|上陸予測の実測|`war-ai-amphibious-v7.json.gz`, `war-ai-amphibious-v7-summary.json`|
|内部目標の追跡|`war-ai-intent-v7.json.gz`|
|表示確認|`war-ai-preview.jpg`|

大きな生成レポートはレビュー時にソース差分を埋めないようgzipで保存する。
行列はgzipを直接出力し、他の診断の非圧縮JSONは保存後にgzipへ変換する。
