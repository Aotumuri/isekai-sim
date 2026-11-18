import fs from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {pairedBootstrap} from '../test/helpers/paired-bootstrap.ts';
const base=process.cwd()+'/';
const paths=['diagnostics/war-ai-r2-19-r1-reference.json.gz','diagnostics/war-ai-r2-19-development.json.gz','diagnostics/war-ai-r2-13-development.json.gz','diagnostics/war-ai-r2-14-development.json.gz'];
const data=paths.map(p=>JSON.parse(gunzipSync(fs.readFileSync(base+p)).toString()));
const key=(r:any)=>`${r.scenario}:${r.seed}`;
const maps=data.map(d=>new Map(d.results.map((r:any)=>[key(r),r])));
assert.equal(data[0].results.length,40);
for(const d of data){assert.equal(d.failures.length,0);for(const f of ['ticks','partition','seedCount','fullSystems','politicalTurbulence','normalWars','observeWarOutcomes'])assert.deepEqual(d[f],data[0][f]);}
const metrics=['goalHeld','survived','casualties','netLegalValueRate'];
function measure(r:any,role:boolean,metric:string){const ws=r.warOutcomes.wars.filter((w:any)=>w.observedAtTick===0&&w.aggressor===role);assert.ok(ws.length);return ws.reduce((s:number,w:any)=>s+(metric==='goalHeld'?+w.objectiveHeld:metric==='survived'?+w.survived:metric==='casualties'?w.casualties:(w.opponentTerritorySecuredValue-w.homelandLostValue)/Math.max(1,w.openingTerritorialValue)),0)/ws.length;}
for(const r of data[0].results)for(const map of maps){const row:any=map.get(key(r));assert.ok(row);assert.deepEqual(row.startWorld,r.startWorld);assert.deepEqual(row.simulationSettings,r.simulationSettings);assert.deepEqual(row.warOutcomes.wars.filter((w:any)=>w.observedAtTick===0).map((w:any)=>[w.nationId,w.opponentId,w.aggressor,w.objectiveIds,w.objectiveKind]),r.warOutcomes.wars.filter((w:any)=>w.observedAtTick===0).map((w:any)=>[w.nationId,w.opponentId,w.aggressor,w.objectiveIds,w.objectiveKind]));}
assert.equal(pairedBootstrap([0,0]).meanDelta,0);
const scenarios=Object.fromEntries(['stalemate-breaker','reorganization-heavy'].map(scenario=>[scenario,Object.fromEntries([true,false].map(role=>[role?'aggressor':'defender',Object.fromEntries(metrics.map(metric=>{const rows=data[0].results.filter((r:any)=>r.scenario===scenario);assert.equal(rows.length,20);const values=rows.map((r:any)=>maps.map(m=>measure(m.get(key(r)),role,metric)));const r1=values.map((v:number[])=>v[1]-v[0]),r2=values.map((v:number[])=>v[3]-v[2]);return [metric,{r1MarchEffect:pairedBootstrap(r1),r2MarchEffect:pairedBootstrap(r2),interaction:pairedBootstrap(r2.map((v:number,i:number)=>v-r1[i]))}];}))]))]));
fs.writeFileSync(base+'diagnostics/war-ai-r2-19-controller-interaction.json.gz',gzipSync(JSON.stringify({paths,formula:'(R2.14 - R2.13) - (R2.19 - R1)',commonStartsSettingsAndExternalGoalsExact:true,scenarios,note:'Paired seed bootstrap, fixed 10000 resamples. Controller-bundle interaction, not identification of one coefficient or mechanism. Casualties cover opening wars only; no opposing interests are combined.'})));
for(const [s,roles]of Object.entries(scenarios))for(const [r,m]of Object.entries(roles as any))console.log(s,r,JSON.stringify((m as any).survived.interaction));
