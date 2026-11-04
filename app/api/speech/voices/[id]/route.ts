import { speechResponse } from "@/src/server";
export const dynamic = "force-dynamic";
export async function DELETE(request: Request, ctx: {params: Promise<{id:string}>}) {return speechResponse(request,"remove",(await ctx.params).id);}
