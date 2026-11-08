import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {join} from 'node:path';
import {Coordinator} from '../src/coordinator.ts';
import {openDb} from '../src/db.ts';
import {buildMethods,localClient} from '../src/api.ts';
import {listHeld} from '../src/budgets.ts';
import {recover} from '../src/janitor.ts';
import {groupAlive,processStartTime,terminateOwnedGroup} from '../src/proc.ts';
import {recordUtility,runUtilityKey} from '../src/utility-records.ts';
import {sandbox} from './helpers.ts';

async function fixture(machineId='m-remote',review=true){
 const box=sandbox({budget:{dailyUsd:20,perTaskUsd:3},review:{mode:'never',budgetUsd:1},cleanup:{auto:false}});
 const coord=new Coordinator(openDb(join(box.home,'review-recovery.db')));const project=await coord.registerProject(box.repo);
 coord.addTasks(project.id,[{title:'Recover every reviewer process',agent:'mock',files:['review/**']}],'fixture');
 const task=coord.claimNext({machineId,agents:['mock'],repos:{[project.id]:box.repo},runningByAgent:{}})!.task;
 const client=localClient(buildMethods(coord,{machineId:'m-hub'}));
 if(!review)return{...box,coord,project,task,client};
 const implementation=coord.startRun(task,machineId,'mock',null,'');coord.updateTask(task.id,{status:'verifying'});
 const reviewer=coord.startRun(coord.getTask(task.id)!,machineId,'mock',null,'','review',implementation.id);
 return{...box,coord,project,task,client,implementation,reviewer};
}
async function sleeper(){const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','pipe','ignore']});await once(child.stdout!,'data');return child;}

for(const phase of ['review_wait','review:spawning','review'])test(`expired remote ${phase} is held with all unresolved runs and owner recovery releases its budget`,async()=>{
 const f=await fixture();const child=phase==='review'?await sleeper():undefined;
 try{
  const run=f.reviewer!;const implementation=f.implementation!;
  f.coord.updateRun(run.id,{phase,...child?{pid:child.pid!,proc_started:await processStartTime(child.pid!)}:{}});
  // A finished leader can still own a pending utility; it must be covered by the same remote hold.
  recordUtility(f.coord.db,runUtilityKey(implementation.id),{action:'intent',token:'late-owned-utility',command:'git'});
  f.coord.updateTask(f.task.id,{lease_until:Date.now()-1});
  await recover(f.coord,'m-hub',new Set());
  assert.equal(f.coord.getTask(f.task.id)!.status,'needs_human');
  for(const id of [run.id,implementation.id]){assert.equal(f.coord.getRun(id)!.status,'cleanup_failed');assert.equal(f.coord.getMeta(`recovery:${id}`),'remote_lease_expired');}
  assert.equal(listHeld(f.coord.db).length,1,'the review reservation remains until exit proof');
  if(child)assert.equal(groupAlive(child.pid!),true,'a remote PID never authorizes signaling on this hub');
  f.coord.control(f.task.id,'retry','fixture');
  assert.equal(f.coord.claimNext({machineId:'m-new',agents:['mock'],repos:{[f.project.id]:f.repo},runningByAgent:{}}),null);
  if(child)await terminateOwnedGroup(child.pid!,{graceMs:20});
  await f.client['task.control']({id:f.task.id,action:'confirm-stopped',remote:true,note:'Every remote reviewer and utility group was inspected and stopped.'});
  assert.equal(listHeld(f.coord.db).length,0);
  for(const id of [run.id,implementation.id]){assert.equal(f.coord.getRun(id)!.status,'stopped');assert.equal(f.coord.getMeta(`recovery:${id}`),null);}
  const replacement=f.coord.claimNext({machineId:'m-new',agents:['mock'],repos:{[f.project.id]:f.repo},runningByAgent:{}})!;
  assert.ok(replacement.task.generation>f.task.generation);
 }finally{if(child)await terminateOwnedGroup(child.pid!,{graceMs:20});f.coord.db.close();}
});

test('a local orphan reviewer is reaped before retry even while its task lease is fresh',async()=>{
 const f=await fixture('m-hub');const child=await sleeper();
 try{
  f.coord.updateRun(f.reviewer!.id,{phase:'review',pid:child.pid!,proc_started:await processStartTime(child.pid!)});
  assert.ok(f.coord.getTask(f.task.id)!.lease_until!>Date.now());
  await recover(f.coord,'m-hub',new Set(),{startup:true});
  assert.equal(groupAlive(child.pid!),false);assert.equal(f.coord.getRun(f.reviewer!.id)!.status,'stopped');
  assert.equal(listHeld(f.coord.db).length,0);assert.equal(f.coord.getTask(f.task.id)!.status,'queued');
 }finally{await terminateOwnedGroup(child.pid!,{graceMs:20});f.coord.db.close();}
});

test('remote recovery rechecks a replaced snapshot before changing its new generation',async()=>{
 const f=await fixture('m-remote',false);
 try{
  f.coord.updateTask(f.task.id,{lease_until:Date.now()-1});
  const original=f.coord.listTasks.bind(f.coord);let replacement:ReturnType<Coordinator['getTask']>=null;let injected=false;
  f.coord.listTasks=(projectId,statuses)=>{
   const snapshot=original(projectId,statuses);
   if(!injected&&statuses?.includes('running')&&statuses.includes('verifying')){
    injected=true;
    f.coord.control(f.task.id,'cancel','fixture');f.coord.control(f.task.id,'retry','fixture');
    replacement=f.coord.claimNext({machineId:'m-new',agents:['mock'],repos:{[f.project.id]:f.repo},runningByAgent:{}})!.task;
   }
   return snapshot;
  };
  await recover(f.coord,'m-hub',new Set());
  const current=f.coord.getTask(f.task.id)!;
  assert.ok(replacement);assert.ok(current.generation>f.task.generation);assert.equal(current.status,'running');
  assert.equal(current.assignee,'machine:m-new');assert.equal(current.machine_id,'m-new');assert.equal(listHeld(f.coord.db).length,1);
 }finally{f.coord.db.close();}
});
