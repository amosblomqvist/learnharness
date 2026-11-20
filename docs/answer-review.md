# Review before the next question

After a builtin graded question (`quiz`, `probe`, `explain` or `recall`) and its tutor feedback finish, a review panel immediately below the feedback offers:

- **Ask about this answer** opens the answered question's existing side conversation. It does not submit the next answer.
- **Explain it to AI** selects optional Feynman practice in that conversation. The learner explains first; the helper follows up on one specific gap at a time. It checks accuracy, connected reasoning and an example/boundary case before ending the questioning. The learner can leave at any time.
- **Continue to next question** reveals the prepared next question. If no question is ready, it sends an explicit request for the next one.

The tutor's existing grading/generation pipeline is unchanged: this is a learner-controlled presentation pause, not a promise that next-question generation is deferred. Pending question content is withheld while the feedback remains readable. Review actions stay in the transcript, 24px after the feedback (an existing side-conversation history entry remains accessible). The bottom dock keeps its utility/model toolbar without reserving a hidden next question’s height. Preference questions, dismissals, failed/unfinished reactions and unanswered parallel batches do not create a review.

Acknowledgement is per answered occurrence and stored in browser local storage, scoped to the session. Reload and other tabs on that browser share it; it is not cross-device progress. Answers and the original material are never rewritten. If local storage is unavailable, Continue still works for the current view.

Feynman/direct-clarification choices are carried as explicit visible tags in the learner's side-chat requests and saved with those messages. Ordinary untagged side questions keep their behavior; retries do not duplicate the tag. The side helper's existing open-assessment spoiler restriction remains in effect. Feynman practice provides model feedback, not an independent certification of understanding.
