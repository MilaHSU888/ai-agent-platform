import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig,entryBlock,transition,modelAllowed,DEFAULT_LOCAL_MODEL,modelKind,normalizeModel,initialDemo,modelsOf} from '../app/demo-management.ts';
const tool={id:'quote',type:'AI',description:'採購試點'};
test('maintenance, delisting and revoked access prevent entry',()=>{
 const c=defaultConfig(tool);
 assert.equal(entryBlock(c),'');
 for(const status of ['維護中','已下架','驗證中','待核准']) assert.ok(entryBlock({...c,status}));
 assert.ok(entryBlock({...c,access:false}));
});
test('publication cannot skip inspection and test; approved tool becomes usable',()=>{
 const c={...defaultConfig(tool),status:'驗證中'};
 assert.throws(()=>transition(c,'待核准'));
 assert.throws(()=>transition(c,'運行中'));
 assert.throws(()=>transition({...c,checked:true},'運行中'));
 const ready=transition({...c,checked:true,tested:true},'待核准');
 assert.equal(entryBlock(transition(ready,'運行中')),'');
});
test('local-only model policy denies cloud; AI tools default to the local 5090 model',()=>{
 const c=defaultConfig(tool);
 assert.equal(modelAllowed(c,'示範雲端模型'),false);
 assert.equal(modelAllowed(c,'示範地端模型'),true);
 assert.equal(modelAllowed({...c,localOnly:false},'示範雲端模型'),true);
 assert.equal(c.model,DEFAULT_LOCAL_MODEL);
 assert.equal(defaultConfig({...tool,type:'非 AI'}).model,'不使用模型');
});
test('model catalog demo: legacy names map to the new catalog and kinds are known',()=>{
 const s=initialDemo();
 assert.equal(normalizeModel('示範地端模型'),DEFAULT_LOCAL_MODEL);
 assert.equal(normalizeModel('核准模型端點（wisely-5090）'),DEFAULT_LOCAL_MODEL);
 assert.equal(modelKind(s,'示範雲端模型'),'雲端');
 assert.equal(modelKind(s,DEFAULT_LOCAL_MODEL),'地端');
 assert.ok(modelsOf(s).some(m=>m.kind==='雲端'&&!m.enabled),'cloud model starts disabled until the customer approves it');
});
