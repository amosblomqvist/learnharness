import {validateSpeechResources} from './speech-resource-validation.mjs';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const [resources,assets]=process.argv.slice(2);
if(!assets)throw new Error('Usage: node scripts/verify-packaged-speech.mjs RESOURCE_DIR TEMP_ASSET_DIR');
if(process.platform!=='linux'||process.arch!=='x64')process.exit(0);
validateSpeechResources(resources);
const lock=JSON.parse(readFileSync('docs/piper-artifacts.lock.json','utf8'));
for(const voice of lock.voices){
 const dir=path.join(assets,voice.id);
 mkdirSync(dir,{recursive:true});
 for(const file of voice.files){
  const response=await fetch(`${lock.repository}/resolve/${lock.revision}/${voice.directory}/${file.name}`,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error(`Download failed: ${voice.id}/${file.name}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error(`Artifact verification failed: ${voice.id}/${file.name}`);
  writeFileSync(path.join(dir,file.name),bytes);
 }
 const r=spawnSync(process.execPath,['scripts/smoke-speech-runtime.mjs',path.join(resources,'piper-helper'),path.join(dir,`${voice.id}.onnx`),path.join(dir,`${voice.id}.onnx.json`),path.join(resources,'share','espeak-ng-data')],{stdio:'inherit'});
 if(r.status!==0)throw new Error(`Packaged speech smoke failed: ${voice.id}`);
}
