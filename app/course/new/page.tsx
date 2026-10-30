import { CourseNew } from "@/components/course-new";

export const dynamic = "force-dynamic";

/** The new-course form (courses plan, 2026-10-30) — a static segment, so
 *  "new" is never read as a course id. */
export default function NewCoursePage() {
	return <CourseNew />;
}
