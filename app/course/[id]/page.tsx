import { notFound } from "next/navigation";
import { CourseViewPage } from "@/components/course-view";
import { courseView, stores } from "@/src/server";

export const dynamic = "force-dynamic";

/** A course: draft review, lessons (list + graph), edits, replan. The
 *  server renders the first view; the client refetches on events. */
export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const record = /^[A-Za-z0-9_-]+$/.test(id) ? stores.courseStore.getCourse(id) : null;
	if (!record) notFound();
	return <CourseViewPage key={record.id} initial={courseView(record)} />;
}
