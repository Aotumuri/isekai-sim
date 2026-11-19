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
| Research | Science and material costs are accounted for once per ten days. Projects continue beyond level 10. Progress, equipment programs and the current ten-day science rate are visible in the research view. |

## Scope and compatibility

The app generates worlds in memory and has no saved-world loader or persistent deadline format to migrate. Existing fast- and slow-tick fields still count engine steps, while newly created worlds schedule their deadlines under these calendar rules. The internal peace terms now carry `truceDays`, campaign observations use loss fractions per day, and the playback clock uses one accumulator. An external snapshot or consumer of older in-memory objects would need an explicit conversion for those fields before loading or resuming.

Regional travel times still use the existing adjacency scale. Geography-sensitive travel, some rapid military outcomes, and the pace of prolonged crises need more calibration on larger maps. The population model covers migration, displacement and deaths. Natural growth remains absent. Long-term historical reconstruction remains a separate project. Material shortages can limit research, and long-run resource accumulation is still governed by the existing production and demand model.

## Research progression policy

Each equipment program keeps independent branch levels and accrued science. Research has no gameplay level ceiling. Upgrading one branch from current level `L` costs `70 + 45L + 3Σ + 3 × max(0, L − 10)²` science, where `Σ` is the sum of current levels in that program. The previous cost applies through the project from level 10 to 11. Doctrine, wartime needs, shortages and focus still set branch weights. At higher levels, the weight is multiplied by `10 / max(10, L)` to keep the more expensive branches competing for science alongside cheaper projects.

Cities, national innovation and research investment determine the ten-day budget. Treasury grants can add up to 60% of capacity when funds and materials are available. Each point of science consumes 0.4 steel, 0.2 weapons and family-specific prototype inputs. The programs share the national budget. When one cannot obtain its prototype materials, its unused allocation is not reassigned that cycle. An old portfolio marked complete at level 10 resumes on the next eligible research cycle. Licenses retain their treaty, trust, influence, material and 1,200-day cooldown requirements. A license grants at most 30% of the project's cost and leaves completion to domestic research. Larger level gaps gradually approach a bonus of 125 science per license.

Equipment designs record actual branch levels and use their sum as the generation. A branch contributes an effective level of `L` through level 10. With `x = L − 10` above that point, its contribution is `10 + 10x / (10 + x)`. Actual levels of 11, 20, 50 and 100 give about 10.91, 15, 18 and 19 effective levels. Combat and equipment calculations use effective levels. This keeps firepower, armor, handling and organization recovery below 2.2×, 2.1×, 1.5× and 1.8× respectively. Movement speed and reliability gradually approach their physical limits of 0.75–1.50× and 0.72–1.28×. Weapons and retrofit steel multipliers approach limits of 0.50–2.85×, and fuel use 0.45–2.05×. Improved firepower, protection, speed and cargo capacity still raise equipment or operational demands. Material, production, reliability, fuel and logistics research can offset those demands. Equipment efficiency affects unit costs and operation. It does not multiply shared factory output or the research budget.

Transport capacity has its own diminishing gain, `1 + 0.1E + 0.6 × (1 − exp(−E / 2))`, where `E` is the effective capacity level. A standard 10-unit ship carries 25 units at level 10, 30 at level 20, and 34 at level 100. The continuous multiplier approaches 3.6×, so the standard ship has at most 35 slots. Cargo and weapons requirements still round to whole units. Small advances may become visible only in combination with later research.

Newly produced units use the design priced for their production batch. Existing units retain their deployed design until a refit or equipment transfer. Automatic refits still field up to two supplied units per nation every 100 days. For designs with a branch above level 10, they wait for more than 2% improvement in combined design utility, recovery, fuel use or steel cost, or an improved whole-unit weapons cost or payload. Refits consume weapons based on the replacement design and steel based on the positive gains in effective levels. The simulation computes each domestic design once per family and nation per refit pass. The rolling event log and per-family announcement tracking retain their existing bounds.

## Calendar validation

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

## Research validation

[The research diagnostic](../test/diagnostics/research-progression.ts) compares the same scenarios against `295bff0`, the calendar implementation before the research changes. Pass a scenario and increasing elapsed-day checkpoints, for example `node --expose-gc --import tsx test/diagnostics/research-progression.ts quick 10000 36500 50000 100000`. The focused setup uses seed 101, six nations, 123 districts and a fixed map and economy. Three nations run the small-arms program with firepower focus, ambitious investment and treasury funding. They start with ample stocks, scarce copper, and ample stocks with all six branches already at level 10, respectively. The test runs actual research and refit updates on the ten-day cadence. It does not run production, trade or battles.

| Elapsed days | Approx. years | Funded from Lv.0 | Copper-constrained | Funded from Lv.10 |
| ---: | ---: | ---: | ---: | ---: |
| 3,650 | 10 | 4 | 0 | 10 |
| 10,000 | 27.4 | 7 | 0 | 11 |
| 36,500 | 100 | 15 | 0 | 15 |
| 50,000 | 137 | 17 | 0 | 16 |
| 73,000 | 200 | 19 | 0 | 18 |
| 100,000 | 274 | 22 | 0 | 20 |

By day 100,000, the original implementation had completed 60 projects and both funded programs had reached a terminal state. The new implementation completed 93 projects (69 and 24 across the funded programs). The from-zero nation's final branch levels were 22, 13, 13, 7, 7 and 7 for firepower, reliability, materials, logistics, production and handling. The scarce program spent 12 science and stopped at its two-unit copper reserve. Across the three programs, research spent 23,957 steel, 11,978 weapons, 14,973 copper and 44,918 treasury funds, up from 8,670, 4,335, 5,419 and 16,256 respectively. Both funded nations still had steel, weapons, copper and treasury reserves at day 100,000. The deployed maximum generation rose from 60 to 84 and firepower from 1.60× to 1.91×. By day 50,000 there had been 281 refits versus 355, and by day 100,000 there were 417 versus 391 as projects continued after the old programs had finished. The sum of fielded unit combat strength rose by 5.2% at the final checkpoint.

The autonomous cases run the daily and ten-day systems together. At day 10,000, the medium case (seed `822748319788`, 2,023 districts) had 14 active nations. Their highest branch levels were distributed as five at Lv.0, five at Lv.1 and four at Lv.2. The two builds matched for all recorded behavioral outcomes, including 46 projects, 53 licenses, 498 refits, seven observed wars all ended, and 1,235 fielded units. Research used 3,951 steel and 1,976 weapons. Active treasury, steel, weapons and fuel ended at 36,860, 233,559, 183,390 and 16,335, respectively.

The quick case (seed `822748319780`, 135 districts) without the optional political-turbulence, campaign and defeated-formation systems retained five of its seven initial nations. Their highest branch levels, sorted by level, were `0/0/1/1/2` at day 10,000, `0/3/4/5/5` at day 50,000, and `0/6/6/7/8` at day 100,000 in both builds. At that last checkpoint there were 103 finished projects in surviving portfolios, 224 refits, 210 licenses and 13 observed wars, all ended. Maximum fielded generation was 28 and firepower was 1.24×. Research used 8,404 steel and 4,202 weapons. Active treasury and weapons stocks reached 36,410 and 243,753. Steel was 34 and fuel was zero. Non-infantry programs could not prototype equipment without fuel, leaving their allocations unused. One active nation finished with no steel or weapons and no completed projects.

The historical case repeats the earlier 50,000-day run with the optional political-turbulence, campaign and defeated-formation systems enabled. Both builds reproduced 16 wars, all ended, and one surviving nation with 27 finished projects. Its infantry levels were 3, 5, 7, 3, 4 and 5 for firepower, reliability, materials, logistics, production and handling. The nation earned 6,406 science, an average of 1.28 per ten-day cycle, and used no treasury grants. It retained about 109,000 weapons and 15,774 treasury funds but ended with 8.2 steel and zero fuel. All other equipment programs remained at Lv.0 and were saving resources at the checkpoint. The earlier Lv.7 result reflects available science spread across the infantry branches and material-limited prototype programs. It occurred below the changed cost threshold. The run ended with 30 fielded units at generation zero, despite 102 cumulative refits, illustrating that national knowledge and fielded equipment can diverge.

Checkpoints sampled finite, nonnegative stocks, treasury and research progress. The focused run produced identical behavioral records on repetition. Automated regression tests cover funded progression past level 10, bounded high-level bonuses, refit and licensing costs, and determinism across playback rates. The browser fixture displayed a level-20 transport program with 42% progress and a capacity of 30 units.

| Scenario | Days | Wall time, before → after | CPU time, before → after | Peak RSS, before → after | Final heap after GC, before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Focused | 100,000 | 0.54 → 0.40 s | 0.78 → 0.66 s | 164 → 170 MiB | 23.6 → 23.6 MiB |
| Quick autonomous | 100,000 | 24.06 → 25.54 s | 29.73 → 31.16 s | 382 → 389 MiB | 40.7 → 40.7 MiB |
| Historical autonomous | 50,000 | 9.42 → 9.54 s | 13.67 → 13.74 s | 330 → 334 MiB | 40.5 → 40.5 MiB |
| Medium autonomous | 10,000 | 82.70 → 86.84 s | 92.00 → 96.41 s | 746 → 733 MiB | 275.3 → 275.0 MiB |
| 221 nations, 2,102 districts | 1,000 | 14.77 → 15.06 s | 16.63 → 16.93 s | 816 → 801 MiB | 273.5 → 273.7 MiB |

Single runs include diagnostic sampling and garbage collection. Process CPU was about 0.5–5% higher in the autonomous samples. Repeated timing samples would be needed to establish the size and cause of that difference. The 221-nation case used seed `822748319780` and remained at peace, with all nations active, no complete projects and 609 steel spent on research. The benchmark does not establish sustained wartime throughput at that scale, or late-technology war outcomes. The focused case isolates science and refitting with initial stocks and demonstrates progression when those inputs remain available.

The repository test typecheck, all 778 regression tests and the production build passed. The additional strict app-wide TypeScript check reports the same 39 pre-existing diagnostics as `295bff0`.
