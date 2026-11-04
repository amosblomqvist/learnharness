import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const lock=JSON.parse(readFileSync('native/speech/runtime.lock.json','utf8'));
const [workspace, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: node scripts/prepare-speech-runtime.mjs WORKSPACE OUTPUT');
if(process.platform!=='linux'||process.arch!=='x64') {
 mkdirSync(output,{recursive:true});
 writeFileSync(path.join(output,'unavailable.json'),JSON.stringify({reason:'Piper runtime has not been verified for this platform and architecture.'}));
 process.exit(0);
}
const root=path.resolve(workspace), source=path.join(root,'source'), build=path.join(root,'build'), install=path.join(root,'install');
function run(command,args){const r=spawnSync(command,args,{stdio:'inherit',cwd:process.cwd()});if(r.status!==0)throw new Error(`${command} failed`);}
mkdirSync(root,{recursive:true});
run('git',['clone','--depth','1','--branch','v1.8.0','https://github.com/OHF-Voice/piper1-gpl.git',source]);
const commit=spawnSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'});
if(commit.stdout.trim()!==lock.piper.commit)throw new Error('Piper source revision mismatch');
const archiveUrl=lock.onnxruntimeLinuxX64.url;
const response=await fetch(archiveUrl,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error('ONNX download failed');
const archive=Buffer.from(await response.arrayBuffer());
if(archive.length!==lock.onnxruntimeLinuxX64.bytes || createHash('sha256').update(archive).digest('hex')!==lock.onnxruntimeLinuxX64.sha256)throw new Error('ONNX checksum mismatch');
const archivePath=path.join(root,'onnxruntime.tgz');writeFileSync(archivePath,archive);
run('tar',['-xzf',archivePath,'-C',root]);
run('cmake',['-S',path.join(source,'libpiper'),'-B',build,'-DCMAKE_BUILD_TYPE=Release',`-DCMAKE_INSTALL_PREFIX=${install}`,`-DONNXRUNTIME_DIR=${path.join(root,'onnxruntime-linux-x64-1.22.0')}`]);
run('cmake',['--build',build,'--config','Release','-j','4']);run('cmake',['--install',build,'--config','Release']);
run(process.execPath,['scripts/build-speech-runtime.mjs',install,output]);
const notices=path.join(output,'licenses');mkdirSync(notices,{recursive:true});
cpSync(path.join(source,'COPYING'),path.join(notices,'piper-GPL-3.0.txt'));
cpSync(path.join(build,'espeak_ng','src','espeak_ng_external','COPYING'),path.join(notices,'espeak-GPL-3.0.txt'));

cpSync(path.join(root,'onnxruntime-linux-x64-1.22.0','LICENSE'),path.join(notices,'onnxruntime-MIT.txt'));
cpSync(path.join(root,'onnxruntime-linux-x64-1.22.0','ThirdPartyNotices.txt'),path.join(notices,'onnxruntime-third-party.txt'));
cpSync(path.join(build,'espeak_ng','src','espeak_ng_external-build','_deps','sonic-git-src','LICENSE'),path.join(notices,'sonic.txt'));

for(const [dir,expected] of [[path.join(build,'espeak_ng','src','espeak_ng_external'),lock.espeak.commit],[path.join(build,'espeak_ng','src','espeak_ng_external-build','_deps','sonic-git-src'),lock.sonic.commit]]) {
 const r=spawnSync('git',['-C',dir,'rev-parse','HEAD'],{encoding:'utf8'});if(r.stdout.trim()!==expected)throw new Error('Native dependency revision mismatch');
}

for(const name of ["COPYING.APACHE","COPYING.BSD2","COPYING.UCD"]) cpSync(path.join(build,'espeak_ng','src','espeak_ng_external',name),path.join(notices,`espeak-${name}`));
cpSync(path.join(build,'espeak_ng','src','espeak_ng_external-build','_deps','sonic-git-src','README'),path.join(notices,'sonic-README.txt'));
const voiceRepositoryNotice=readFileSync('native/speech/notices/piper-voices-README.md');
if(voiceRepositoryNotice.length!==lock.voiceRepositoryNotice.bytes||createHash('sha256').update(voiceRepositoryNotice).digest('hex')!==lock.voiceRepositoryNotice.sha256)throw new Error('Voice repository notice mismatch');
cpSync('native/speech/notices',path.join(notices,'learnharness-speech'),{recursive:true});
cpSync('native/speech/runtime.lock.json',path.join(notices,'learnharness-speech','runtime.lock.json'));
