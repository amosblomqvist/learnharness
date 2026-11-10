import { COURSE_PRESETS } from "@/src/core";
import { coursePackSnapshot } from "@/src/server";
import { CoursePack } from "@/components/course-pack";
import type { CoursePackSnapshot } from "@/src/core";

export const dynamic = "force-dynamic";

export default function CoursesPage() {
	let initial: CoursePackSnapshot;
	try {
		initial = coursePackSnapshot();
	} catch (error) {
		initial = {
			presets: COURSE_PRESETS,
			courses: [],
			today: [],
			todayDay: "",
			error: error instanceof Error ? error.message : "Could not read courses.",
		};
	}
	return <CoursePack initial={initial} />;
}
