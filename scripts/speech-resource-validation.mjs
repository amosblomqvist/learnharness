import {readdirSync,realpathSync,readlinkSync} from 'node:fs';
import path from 'node:path';
/** An unpacked resource must never depend on an absolute build-tree symlink. */
export function validateSpeechResources(directory) {
 const root=realpathSync(directory);
 function visit(current){
  for(const entry of readdirSync(current,{withFileTypes:true})){
   const file=path.join(current,entry.name);
   if(entry.isSymbolicLink()){
    if(path.isAbsolute(readlinkSync(file)))throw new Error(`Speech resource symlink is absolute: ${file}`);
    const target=realpathSync(file),relative=path.relative(root,target);
    if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error(`Speech resource symlink escapes bundle: ${file}`);
   }else if(entry.isDirectory())visit(file);
  }
 }
 visit(root);
}
