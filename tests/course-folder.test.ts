import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { courseFile, courseLesson, scanCourse } from "../src/server/course-folder.ts";

test("course selection recurses, suggests uniquely linked vault attachments and starts from selected paths only",async()=>{
	const root=await fs.mkdtemp(path.join(os.tmpdir(),"lh-test-course-"));
	try{
		for(const folder of ["class/week","assets",".private"])await fs.mkdir(path.join(root,folder),{recursive:true});
		const note=path.join("class","week","intro.md"), shared=path.join("assets","shared.pdf");
		await fs.writeFile(path.join(root,note),"![[shared.pdf]] and ![[missing.pdf]]");
		for(const name of [shared,"class/week/lecture.PPT","class/slides.pptx","class/handout.pdf",".private/hidden.pdf"])await fs.writeFile(path.join(root,name),"fixture");
		const {items,notices}=await scanCourse(root,"class");
		assert.equal(items.length,5);assert.deepEqual(items.filter(i=>i.linked),[{id:shared,linked:true}]);assert.match(notices.join(),/missing.pdf/);
		const opening=await courseLesson(root,[note,shared],"Explain these");assert.match(opening,/Explain these/);assert(opening.includes(shared));assert(!opening.includes("slides.pptx"));
		assert.throws(()=>courseFile(root,"../outside.md"));assert.throws(()=>courseFile(root,".private/hidden.pdf"));
		assert.equal(await fs.readFile(path.join(root,note),"utf8"),"![[shared.pdf]] and ![[missing.pdf]]");
	}finally{await fs.rm(root,{recursive:true,force:true});}
});
