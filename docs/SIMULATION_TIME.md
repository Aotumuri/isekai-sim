# Simulation time and long-term progression

## Implemented calendar

One fast tick advances one world day. One slow tick runs after each group of ten fast ticks. The calendar has 365 days per year and starts on Year 1, day 1 at tick zero. There are no leap years. At 10,000 fast ticks, 27.4 years have elapsed. At 100,000 fast ticks, about 274 years have elapsed.

`stepSimulationDay` runs the daily systems and then runs the ten-day systems whenever a cycle closes, before the next day begins. Playback speed, pauses, and the frame processing budget affect when days are delivered. They do not change their length or the order in which systems run. Given an explicit seed, the same number of days, and the same external settings and actions at the same simulation ticks, worlds follow the same sequence. The default map selection can choose a random seed. Wall-clock performance measurements affect frame batching and diagnostics.

`FAST_TICK_MS = 100` and `SLOW_TICK_MS = 1000` are engine scheduling units. `SimTime.elapsedMs` records those accumulated engine units for diagnostics. The world date comes from `fastTick`. Military movement still stores fractional progress in fixed engine units internally, with the same movement speed per day at every playback speed.

[The shared time helpers](../src/sim/time.ts) convert years to days and days to fast or slow ticks. Durations round up to a whole tick of the selected cadence. Deadlines stored in slow ticks are relative to the current ten-day cycle. For example, five years is 1,825 days and is scheduled as 183 slow ticks from that cycle boundary. A manual agreement signed mid-cycle shares that boundary. Remaining-time displays use elapsed days and show zero once a deadline is reached. The map HUD and the rolling world history render the same world date. Event records still store one fast-tick timestamp and retain the latest 200 events.

## System balance

| System | Implemented timing and provisional balance |
| --- | --- |
| Politics | Elections recur every four years. The initial election is staggered across the final 180 days of the first term. Royal succession has deterministic variation across roughly 20–35 years. Support reviews run every 300 days. Existing wartime unrest accumulates under low support. Famine retains its separate path to sustained political instability. |
| Diplomacy and crises | Trade and non-aggression pacts last about five years, alliances about eight, and postwar truces default to five. AI can offer ten years under certain terms and existing manual peace controls also offer fifteen. Friendly partners can extend an eligible truce by about three years in its final year. Peaceful resolution of an ultimatum retains a distinct 1,200-day truce. Territorial concessions have fixed terms. Ultimatums, conferences, transfers and treaty conditions retain their existing ten-day review cadence. |
| War and movement | Movement advances once per day and still uses each unit's travel speed and equipment. Infantry has a baseline of 16 days per region and tanks have four. Campaigns compare estimated arrival and projected losses per day over a 300-day horizon. Replacement capacity in that forecast is available manpower and weapons stock, measured as a share of opening investment. Land travel estimates use the movement rate and round the full path up to a day. Battles, diversions, existing travel progress and naval disruption can change actual arrival. Peace maturity remains 300 days with combat evidence or urgency, and 900 days otherwise. Decisive military outcomes may end a war earlier. |
| Recruitment and recovery | The standard recruitment opportunity is every 100–500 days. Threat and mobilization can shorten it to 20–120 days, with a tighter wartime range. Funds, supply, population capacity and equipment continue to constrain actual recruitment. Readiness rises by at most 2.5 percentage points per ten days. Demobilization starts after 300 quiet days and proceeds in batches. Industrial recovery takes 600 supplied days and funding can halve the remaining time. |
| Food, economy and trade | Production and consumption flows settle every ten days. Food, tax receipts and routine migration settle every 100 days. Reserve estimates use calendar days at the current deficit and famine still depends on consecutive shortage cycles. Resource reparations settle every 300 days through the current truce and an installment due at expiry is canceled. |
| Research | Science and material costs are accounted for once per ten days. Project costs, allocation, unlocks, and level-10 limits are preserved. The research view labels science by its accounting period. |

## Scope and compatibility

The app generates worlds in memory and has no saved-world loader or persistent deadline format to migrate. Existing fast- and slow-tick fields still count engine steps, while newly created worlds schedule their deadlines under these calendar rules. The internal peace terms now carry `truceDays`, campaign observations use loss fractions per day, and the playback clock uses one accumulator. An external snapshot or consumer of older in-memory objects would need an explicit conversion for those fields before loading or resuming.

Regional travel times still use the existing adjacency scale. Geography-sensitive travel, some rapid military outcomes, and the pace of prolonged crises need more calibration on larger maps. The population model covers migration, displacement and deaths. Natural growth remains absent. Long-term historical reconstruction and research beyond level 10 remain separate projects. Material shortages can limit research, and long-run resource accumulation is still governed by the existing production and demand model.

## Research progression policy

Future work should remove the level-10 restrictions in project selection and equipment design, increase project costs at higher levels, and control marginal benefits. Technology should continue to advance as physical performance saturates. Investment, resources, policy and technology exchange should preserve national differences and deterministic outcomes.

## Validation

The regression tests cover calendar boundaries, duration rounding, frame batching across playback speeds, elections, treaty and truce expiry, forecast versus land movement, and the food, tax and research accounting cadence. The map HUD and world-history dates were also checked in the browser.

The existing `active-war` throughput benchmark used seed `822748319788`, 1,920 × 1,080 map settings and 10,000 fast ticks. Both runs went from 14 to 17 total nations, with eight active nations, 305 units and four active wars at the end. All 432 behavioral counters matched. Before and after wall time was 55.4 s and 58.8 s, respectively, or 180.6 and 170.2 ticks/s. Process CPU time was 63.0 s and 65.0 s. Peak RSS was 1,157 and 788 MiB. These are single-run measurements subject to system load, instrumentation and garbage collection. The scenario isolates the original military path and disables the optional society systems.

The repository test typecheck, all 773 tests, and the production build passed. An additional strict app-wide TypeScript check reported the same 39 diagnostics on the baseline and the migrated branch.

An additional autonomous run used seed `822748319788`, 2,023 districts, and 14 initial nations with the society systems enabled. It sampled the existing world invariants and finite, nonnegative stocks, treasury, food, population and research values. The comparison expresses baseline fast-tick spans in days for a common scale.

| At 10,000 days | Baseline | Calendar |
| --- | ---: | ---: |
| Total / active nations | 15 / 13 | 18 / 13 |
| Wars started / ended / still active | 19 / 19 / 0 | 32 / 25 / 7 |
| Recorded peace agreements | 15 | 21 |
| Median duration of ended wars | 700 days | 710 days |
| Treaty grants and renewals observed / past their deadline | 143 / 80 | 214 / 164 |
| Elections / incumbent changes / revolutions | 20 / 6 / 1 | 60 / 17 / 4 |
| Units at end / peak | 1,238 / 1,479 | 1,710 / 1,937 |
| Recruitment / demobilization | 3,505 / 1,289 | 3,811 / 1,014 |
| Completed research projects / highest branch level | 45 / 2 | 45 / 2 |
| Total active treasury | 35,800 | 33,598 |
| Active manpower / weapons stocks | 39.1M / 175.7k | 36.1M / 174.4k |
| Population / nations in famine | 2,331 / 0 | 2,331 / 0 |
| Wall time / process CPU time | 142.9 s / 140.8 s | 188.5 s / 187.2 s |
| Peak RSS / final heap after GC | 692 MiB / 283 MiB | 695 MiB / 280 MiB |

The higher CPU cost in this seed coincided with more active wars and more units. The military-only run had a smaller CPU difference with matching behavioral counters. Treaties were renewed and expired more frequently under the shorter terms. The food system ran throughout this scenario without a famine.

A second seed, `822748319780`, ran for 50,000 days on the quick map with seven initial nations. The baseline ended with three active nations, and the calendar run had one active nation by day 20,000. The calendar run ended all 16 wars and signed five peace agreements. The median duration of an ended war was 136 days, compared with 310 days across 13 ended wars at baseline. This seed shows earlier consolidation and some very short wars on small maps. At 50,000 days population was 243 in both runs and neither recorded famine. Active treasury and weapons stocks were 15,774 and 109.0k in the calendar run versus 15,981 and 120.9k at baseline. Stocks continued rising after consolidation. The surviving nation's research reached level 7, with 27 projects in active portfolios overall. The calendar run's post-GC heap was about 39–40 MiB from day 10,000 onward. This is a long-duration check with a small number of nations.

The scale check used the same second seed with 221 initial nations and 2,102 districts. It completed 1,000 days in 19.2 s wall time and 22.5 s process CPU time, with a peak RSS of 662 MiB. All 221 nations remained active and 1,289 trade or non-aggression pacts were active by the end. This was a peaceful early-game sample. The 664-nation stress attempt was stopped before the 1,000-day checkpoint. Sustained wartime performance at hundreds of nations and longer horizons remains unverified.
