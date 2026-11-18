# プレアルファの国家AI

World Map と Japan Scale の新規ワールドでは国家戦争計画を既定で有効にする。戦争の目的と許容負担を維持し、戦線配分、作戦、予備隊、海軍、生産、講和の既存処理に方針を渡す。領土請求は最後通牒から宣戦と終結後の法的領有まで追跡する。選挙前の連立支持はAIの領土要求に影響し、戦域指揮官は増援が間に合う場合に一度だけ発進を待てる。

デバッグ画面の **D** → **National war plans** でワールド単位に切り替えられる。**Strategic summary** で計画と指揮官の判断を表示する。領土請求の経緯と終結結果は **Claims** で確認できる。無効化すると新しい計画と計画固有の指示が止まり、次の slow tick で計画状態を破棄する。すでに成立した合意、進行中の領土請求、所有権、プレイヤーの直接命令は引き継ぐ。汎用ワールド設定での明示的なオフや、設定項目のない既存のワールド状態は従来どおり扱う。

## 検証

Node 24.22.1。通常の `npm test` は型検査と回帰745件が成功。手動の陸上命令、講和、戦争中のオフ→手動講和→再オン、戦費の分母補正を含む。`npm run build` と `npm run benchmark:quick`（200 fast tick／20 slow tick）も成功。アプリ全体の厳格型検査では main と同じ既知の38診断、Viteでは既存のチャンクサイズ警告が出る。

| 開発シードと条件 | fast tick | main / 有効時のCPU | 観測 |
| --- | ---: | ---: | --- |
| 822748319791、640×360の平時開始 | 10,000 | 4.73 / 4.29秒 | main 7開戦、有効時6開戦。双方で交渉講和2件。新AIで請求の終結結果12件 |
| 822748319796、実寸Japan Scale、17か国 | 1,500 | 4.12 / 4.36秒 | 双方で自然開戦4件、交渉講和0件。終了時のGC後ヒープ211 / 212 MiB |
| 822748319788、実寸World Map、29か国 | 1,500 | 7.06 / 7.28秒 | 双方で自然開戦5件、交渉講和0件。終了時のGC後ヒープ398 / 399 MiB |
| 822748319788、640×360の初期兵力2対1 | 2,500 | 有効時1.93秒 | 観測した戦争3件、終了時に1件が継続 |
| 822748319790、640×360の戦時資源不足 | 2,500 | 有効時1.43秒 | 観測した戦争4件、終了時に交戦なし |

CPUは同一機で順に計測したシミュレーション区間。展開が異なるため、AIの純粋な処理コストや全マップでの性能を表す値ではない。100 tickごとの不変条件、資源残高、履歴上限を検査した。平時開始の同一入力を既定オンで2回再生し、軍・資源・講和・乱数と国家計画のハッシュが一致した。明示オフでも同じ入力で main と軍・資源・講和・乱数のハッシュが一致した。

### 再現

```sh
node --expose-gc --import tsx test/benchmark/campaign-integration-smoke.ts quick 822748319791 10000 default
node --expose-gc --import tsx test/benchmark/campaign-integration-smoke.ts quick 822748319791 10000 off
node --expose-gc --import tsx test/benchmark/campaign-integration-smoke.ts japan-scale 822748319796 1500 default
node --expose-gc --import tsx test/benchmark/campaign-integration-smoke.ts world-map 822748319788 1500 default
node --expose-gc --import tsx test/benchmark/campaign-integration-smoke.ts unequal-war 822748319788 2500 default
node --expose-gc --import tsx test/benchmark/campaign-integration-smoke.ts economic-constraint 822748319790 2500 default
```

main 側の対照は、同じ検証スクリプトを `51f126fc8f3229925d8f1a15c621b3809ff2f5de` の作業ツリーの同じ相対パスに置き、通常開始の3ケースを `off` で実行する。予約済みの最終評価シードは未使用。

## 既知の限界

- 旧AIに対する一般的な戦略優位は未実証。過去の開発比較には膠着時の防衛側存続が悪化した例がある。守備割当を即時反映する修正は旧位置への不要な行軍を減らすが、首都防衛や救援の成功を保証しない。
- 選挙による見送りと追加集結待ちは制御ケースで確認済み。既存の自然進行17シードではどちらも観測されていない。攻勢を継続できた事例が少なく、攻勢時の戦費較正にも限界がある。
- 実寸マップでの長期戦、首都防衛、最大速度での描画性能は引き続き観察する。

移植元と研究記録は [PR #2](https://github.com/Aotumuri/isekai-sim/pull/2) の `316494fa73e68536e1e10efc493dab4a36bbb118` に固定。採用の経緯、開発シードと再生条件、原データの所在は [引き継ぎ](https://github.com/Aotumuri/isekai-sim/blob/316494fa73e68536e1e10efc493dab4a36bbb118/docs/AI_R2_HANDOFF.md) と [行動検証](https://github.com/Aotumuri/isekai-sim/blob/316494fa73e68536e1e10efc493dab4a36bbb118/docs/AI_BEHAVIOR_VALIDATION.md) を参照。
