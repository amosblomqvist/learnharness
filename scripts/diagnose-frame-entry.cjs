// SCRATCH-ONLY native scheduling measurement, NEVER product code.
// Only one owned browser-service window; nonce-authenticated parent IPC.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {app}=require('electron');
assert.equal(process.versions.electron,'44.9.3');
assert.ok(process.argv.includes('--browser-service'));
assert.ok(process.connected&&process.send,'owned parent IPC required');
const home=fs.realpathSync(process.env.SVG_FRAME_HOME);
const source=fs.realpathSync(process.env.SVG_FRAME_SOURCE_MAIN);
const nonce=process.env.SVG_FRAME_NONCE;
assert.match(nonce||'',/^[a-f0-9]{64}$/);
const bytes=fs.readFileSync(source);
assert.equal(createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g,'\n')).digest('hex'),'ccc34cdda5e70e72d07f601aa5ee4c16ec937767895797a01df5d19c13223857');
const began=performance.now();
let owned,contents,windowCount=0,shamUsed=false,shamAckWritten=false,transitionUsed=false,postUsed=false,eventCount=0;
function emit(event,data={}){
  if(++eventCount>100)return;
  fs.appendFileSync(path.join(home,'native-events.ndjson'),JSON.stringify({event,ms:performance.now()-began,epochMs:Date.now(),...data})+'\n');
}
function reply(id,result,error,onWritten){
  if(!process.connected)return;
  try{process.send({namespace:'svg-frame-scheduling-v1',nonce,id,...(error?{error:String(error)}:{result})},error=>{if(!error)onWritten?.()})}catch{}
}
app.on('browser-window-created',(_event,window)=>{
  assert.equal(++windowCount,1,'exactly one owned helper window');
  owned=window;contents=window.webContents;
  emit('browser-window-created');
  for(const event of ['show','hide','ready-to-show','closed'])window.on(event,()=>emit('window:'+event));
});
process.on('message',message=>{
  if(!message||message.namespace!=='svg-frame-scheduling-v1'||message.nonce!==nonce||!/^request-[1-9][0-9]*$/.test(message.id||''))return;
  if(!['sham','transition','post-settlement'].includes(message.command))return;
  const received={command:message.command,id:message.id};emit('ipc-received',received);
  try{
    assert.equal(windowCount,1);assert.ok(owned&&contents);
    if(message.command==='sham'){
      // Constant ACK: NO native getters, state query, JS, or window action.
      assert.equal(shamUsed,false);assert.equal(transitionUsed,false);assert.equal(postUsed,false);
      shamUsed=true;emit('sham-constant-ack',received);
      reply(message.id,{ack:'sham'},undefined,()=>{shamAckWritten=true});return;
    }
    if(message.command==='transition'){
      assert.equal(shamUsed,true);assert.equal(shamAckWritten,true);
      assert.equal(transitionUsed,false);assert.equal(postUsed,false);transitionUsed=true;
      const before=contents.backgroundThrottling;assert.equal(before,true);
      contents.backgroundThrottling=false; // SOLE active native intervention.
      const after=contents.backgroundThrottling;assert.equal(after,false);
      const result={before,after,transitionApplied:true};emit('transition-applied',{...received,...result});
      reply(message.id,result);return;
    }
    // The parent ONLY sends this after original CDP settlement/source finally.
    assert.equal(message.originalSettled,true);assert.equal(postUsed,false);postUsed=true;
    const result={isVisible:owned.isVisible(),transitionUsed};
    emit('post-settlement',result);reply(message.id,result);
  }catch(error){emit('ipc-error',{...received,error:String(error)});reply(message.id,null,error)}
});
emit('entry-registered',{electron:process.versions.electron});
require(source); // exact unchanged a917 main; its IPC disconnect owns lifetime
