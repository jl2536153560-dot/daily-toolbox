const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./support/transcription-fixture.cjs');
const video=path.resolve(__dirname,'../extensions/video-collector');
const settings={enabled:true,authMode:'personalBaseToken',personalBaseToken:'offline-test-token',appToken:'baseExample',tableId:'tblExample'};

test('public installation is unconfigured, does not import local settings, and starts no network call',async()=>{
  const f=fixture();
  const feishu=await f.api.getFeishuSettings(); const asr=await f.api.getTranscriptionSettings();
  assert.equal(feishu.enabled,false);assert.equal(feishu.authMode,'personalBaseToken');
  for(const key of ['personalBaseToken','appId','appSecret','appToken','tableId'])assert.equal(feishu[key],'');
  assert.equal(asr.apiKey,'');assert.equal(asr.enabled,false);
  assert.equal((await f.api.getMonitorSettings()).enabled,false);
  assert.equal(f.requests.length,0);
});
test('incomplete public configuration cannot submit a Feishu request',()=>{
  const f=fixture();assert.throws(()=>f.api.normalizeSettings({}),/飞书配置不完整/);assert.equal(f.requests.length,0);
});
test('saving changed application credentials clears cached authorization but ordinary edits preserve it',async()=>{
  const initial={...settings,authMode:'openApi',appId:'appExampleA',appSecret:'secretExampleA'};
  const token={token:'offline-cached-token',appId:initial.appId,expiresAt:Date.now()+3600000};
  const f=fixture({stored:{feishu:initial,feishuTokenCache:token}});
  await f.api.saveFeishuSettings({...initial,collectorName:'Test collector'});
  assert.equal(f.storage.feishuTokenCache.token,token.token);
  await f.api.saveFeishuSettings({...initial,appSecret:'secretExampleB'});
  assert.equal(f.storage.feishuTokenCache,null);
  f.storage.feishuTokenCache=token;
  await f.api.saveFeishuSettings({...initial,authMode:'personalBaseToken'});
  assert.equal(f.storage.feishuTokenCache,null);
});
test('testing another application never reuses the previous application token',async()=>{
  const f=fixture({stored:{feishuTokenCache:{token:'offline-old-token',appId:'appExampleA',expiresAt:Date.now()+3600000}},
    onFetch:async()=>({ok:true,json:async()=>({code:0,tenant_access_token:'offline-new-token',expire:7200})})});
  const auth=await f.api.getFeishuAuth({...settings,authMode:'openApi',appId:'appExampleB',appSecret:'secretExampleB'});
  assert.equal(auth.token,'offline-new-token');assert.equal(f.requests.length,1);
  assert.equal(f.storage.feishuTokenCache.appId,'appExampleB');
});
test('personal authorization only uses the provided credential and standard API',async()=>{
  const f=fixture();const auth=await f.api.getFeishuAuth(f.api.normalizeSettings(settings));
  assert.equal(auth.token,settings.personalBaseToken);assert.equal(auth.apiBase,'https://base-api.feishu.cn/open-apis');
  assert.equal(auth.native,undefined);assert.equal(f.requests.length,0);
});
test('removed local-connector mode falls back to an unconfigured personal mode',async()=>{
  const f=fixture();await f.api.saveFeishuSettings({authMode:'native',appToken:'baseExample',tableId:'tblExample'});
  assert.equal(f.storage.feishu.authMode,'personalBaseToken');
  assert.throws(()=>f.api.normalizeSettings(f.storage.feishu),/personalBaseToken/);
});
test('each user-selected video table is used exactly, without creating an unrelated target',async()=>{
  const f=fixture();f.api.listTables=async()=>[{table_id:'tblOther',name:'竞品达人视频数据'},{table_id:'tblExample',name:'自己的视频表'}];
  const selected=await f.api.getOrCreateWorksTable(settings,{},{});assert.equal(selected.table_id,'tblExample');
  f.api.listTables=async()=>[{table_id:'tblOther'}];
  await assert.rejects(f.api.getOrCreateWorksTable(settings,{},{}),/视频数据表不存在/);
});
test('connection verification reads both schema and records and never writes',async()=>{
  const f=fixture();const calls=[];f.api.listFields=async()=>[{field_name:'标题'}];
  f.api.feishuApi=async(method,url)=>{calls.push({method,url});return {items:[]}};
  const result=await f.api.testFeishu(settings);assert.equal(result.recordsReadable,true);
  assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.match(calls[0].url,/tblExample\/records\?page_size=1$/);
});
test('published manifests resolve every asset, have independent identity, and require no native host',()=>{
  for(const folder of ['video-collector','comment-assistant']){
    const dir=path.resolve(video,'..',folder),m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
    const files=[...Object.values(m.icons||{}),m.background?.service_worker,m.action?.default_popup,m.options_page,
      ...Object.values(m.action?.default_icon||{}),...(m.content_scripts||[]).flatMap(s=>[...(s.js||[]),...(s.css||[])])].filter(Boolean);
    for(const file of files)assert.ok(fs.existsSync(path.join(dir,file)),folder+'/'+file);
    assert.equal(m.version,'1.0.3');assert.equal(m.key,undefined);assert.ok(!m.permissions.includes('nativeMessaging'));
  }
});
test('public video has no automatic local connector or hardwired personal Feishu link',()=>{
  const background=fs.readFileSync(path.join(video,'background.js'),'utf8');
  const html=fs.readFileSync(path.join(video,'options.html'),'utf8');
  assert.ok(!background.includes('sendNativeMessage'));assert.ok(!background.includes('bootstrapLocalSettings'));
  assert.ok(!background.includes('DEFAULT_TARGET_BASE'));assert.ok(!html.includes('value="native"'));
  assert.ok(!/href="https:\/\/[^"/]+\.feishu\.cn\/(?:wiki|base)\//.test(html));
});
