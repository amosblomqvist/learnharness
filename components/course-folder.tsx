"use client";
import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { CourseItem } from "@/src/server/course-folder";

export function CourseFolder({folder, expanded, expand, request, launch}:{folder:string;expanded:boolean;expand:(value:boolean)=>void;request:<T>(body:object)=>Promise<T>;launch:(prompt:string)=>Promise<void>}) {
	const [items,setItems]=useState<CourseItem[]>(),[selected,setSelected]=useState<Set<string>>(new Set());
	const [notices,setNotices]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(""),[goal,setGoal]=useState("");
	async function act(fn:()=>Promise<void>){setBusy(true);setError("");try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
	async function scan(){
		const result=await request<{items:CourseItem[];notices:string[]}>({op:"scanCourse",folder});
		expand(true);setItems(result.items);setSelected(new Set(result.items.filter(i=>!i.linked).map(i=>i.id)));setNotices(result.notices);
	}
	return <section className="my-4 grid gap-3 border-y py-4" aria-label="Course folder">
		<div><Button variant="outline" disabled={busy} onClick={()=>expanded ? expand(false) : void act(scan)}>{expanded ? "Back to individual files" : "Study this folder"}</Button></div>
		{expanded && items && <><p className="text-sm">{selected.size} of {items.length} files selected, including subfolders. Slides are converted to PDF for the lesson.</p>
		<div className="max-h-72 overflow-auto">{items.map(item=><div key={item.id} className="flex items-center justify-between gap-2 py-1"><label className="flex min-w-0 items-center gap-2 text-sm"><input type="checkbox" className="size-4 shrink-0 accent-[var(--lh-accent)]" disabled={busy} checked={selected.has(item.id)} onChange={()=>setSelected(prev=>{const next=new Set(prev);if(next.has(item.id))next.delete(item.id);else next.add(item.id);return next;})}/><span className="break-all">{item.id}{item.linked && " (linked attachment)"}</span></label>{/\.md$/i.test(item.id) && <Button size="sm" variant="ghost" disabled={busy} onClick={()=>void act(async()=>{await request({op:"openCourseNote",id:item.id});})}>Open in Obsidian</Button>}</div>)}</div>
		{notices.map(n=><p key={n} className="text-sm text-muted-foreground">{n}</p>)}
		<Input value={goal} onChange={e=>setGoal(e.target.value)} aria-label="Course learning goal" placeholder="What should the lesson focus on? (optional)"/>
		<div><Button disabled={busy || !selected.size} onClick={()=>void act(async()=>{const result=await request<{prompt:string}>({op:"courseLesson",ids:[...selected],goal});await launch(result.prompt);})}>Start course lesson</Button></div></>}
		{busy && <p role="status">Preparing course materials…</p>}{error && <p role="alert">{error}</p>}
	</section>;
}
