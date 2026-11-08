import {validateSpeechResources} from './speech-resource-validation.mjs';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
const [piperRoot,output] = process.argv.slice(2);
if(!piperRoot || !output) throw new Error('Usage: node scripts/build-speech-runtime.mjs PINNED_PIPER_INSTALL OUTPUT');
const build=path.resolve('.next/speech-build');
function run(args){const result=spawnSync('cmake',args,{stdio:'inherit'});if(result.status!==0)throw new Error('Speech build failed');}
run(['-S','native/speech','-B',build,`-DPIPER_ROOT=${path.resolve(piperRoot)}`,`-DCMAKE_INSTALL_PREFIX=${path.resolve(output)}`,'-DCMAKE_BUILD_TYPE=Release']);
run(['--build',build,'--config','Release']);run(['--install',build,'--config','Release']);
mkdirSync(output,{recursive:true});
cpSync(path.join(piperRoot,'lib'),path.join(output,'lib'),{recursive:true,verbatimSymlinks:true});
cpSync(path.join(piperRoot,'share','espeak-ng-data'),path.join(output,'share','espeak-ng-data'),{recursive:true});
// Windows resolves dependent DLLs beside the executable.
if(process.platform==='win32' && existsSync(path.join(piperRoot,'bin'))) cpSync(path.join(piperRoot,'bin'),output,{recursive:true});

validateSpeechResources(output);
