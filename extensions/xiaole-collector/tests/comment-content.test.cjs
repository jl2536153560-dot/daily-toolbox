const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,clone}=require('./support/transcription-fixture.cjs');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('public B站 capture skips declared custom stickers before selecting hot comments',async()=>{
 const f=fixture({onFetch:async request=>({ok:true,json:async()=>({code:0,data:request.url.includes('/view?')?{bvid:'BV1xx411c7mD',aid:2,title:'示例',owner:{mid:1,name:'作者'},stat:{},pages:[{page:1,cid:2}]}:request.url.includes('/reply?')?{replies:['[doge]','[自定义开心]','怎么做😂','求教程','多少钱'].map((message,i)=>({rpid:i+1,like:10-i,content:{message,emote:{'[自定义开心]':{type:3}}}}))}:[]})})});
 f.api.chrome.runtime.id='offline-fixture';f.api.chrome.declarativeNetRequest={updateDynamicRules:async()=>{}};
 for(const name of ['bilibili-core.js','bilibili-background.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../extensions/video-collector',name),'utf8'),f.api);
 const result=await f.api.BiliBg.collectSingle('https://www.bilibili.com/video/BV1xx411c7mD/',{includeComments:true});
 assert.match(result.works[0].hotCommentsText,/怎么做😂/);assert.match(result.works[0].hotCommentsText,/多少钱/);assert.doesNotMatch(result.works[0].hotCommentsText,/doge|自定义开心/);
});
test('Douyin hot comments filter before selecting top three, preserving mixed text',()=>{
 const f=fixture();
 const rows=[['[捂脸]',999],['😂👍',998],['[图片]',997],['怎么做😂',10],['预算200够吗',9],['[多少钱]',8]].map(([text,digg_count])=>({text,digg_count,user:{nickname:'作者'}}));
 assert.deepEqual(clone(f.api.normalizeDouyinComments(rows)).map(r=>r.text),['怎么做😂','预算200够吗','[多少钱]']);
 assert.deepEqual(clone(f.api.mergeUniqueDouyinComments([{text:'[图片]',author:'A'}],[{text:'求教程',author:'B'},{text:'👍',author:'C'}])).map(r=>r.text),['求教程']);
});
