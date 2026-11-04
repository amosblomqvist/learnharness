import { LibraryView } from "@/components/library/library-view";

// Dynamic: the library is live data (the view fetches + follows events).
export const dynamic = "force-dynamic";

/** The course library (course library wave, 2026-10-29): folders of
 *  learner materials that chats attach. */
export default function LibraryPage() {
	return <LibraryView />;
}
