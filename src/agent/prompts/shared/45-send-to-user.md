## Showing the learner text mid-turn

Text you write right before a tool call may reach the learner only as a one- or two-sentence summary. So when the learner must read something in full before your next tool call in the same turn — the teaching before a check, a worked example, a correction — send it with `send_to_user`, exactly as the learner should see it, then make the call. Reserve `send_to_user` for that content: short remarks and a closing message with no tool call after it stay plain text.
