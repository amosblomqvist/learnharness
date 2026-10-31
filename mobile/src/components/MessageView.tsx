// One projected view message (core/view.ts LhViewMessage). Phase 0 renders
// the chat core: user bubbles, assistant text, a thinking row, answered
// question cards, and a quiet chip for every other tool call.
import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { QUESTION_TOOLS, toolActivityLabel, type LhViewMessage, type LhViewPart, type QuestionAnswerData } from "@core";
import { Markdown } from "@/components/Markdown";
import { unwrapPlainMath } from "@/lib/plain-math";
import { colors, radius, space } from "@/lib/theme";

const QUESTION_TOOL_SET = new Set<string>(QUESTION_TOOLS);

function toolName(part: LhViewPart): string | null {
  return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : null;
}

export const MessageView = memo(function MessageView({ message }: { message: LhViewMessage }) {
  if (message.role === "user") {
    const text = message.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
    if (!text) return null;
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text style={styles.userText} selectable>
            {text}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.assistant}>
      {message.parts.map((part, i) => (
        <PartView key={part.id ?? i} part={part} />
      ))}
    </View>
  );
});

function PartView({ part }: { part: LhViewPart }) {
  if (part.type === "text") return part.text ? <Markdown text={part.text} /> : null;
  if (part.type === "reasoning") return part.text ? null : <Text style={styles.thinking}>Thinking…</Text>;
  const tool = toolName(part);
  if (!tool) return null;
  if (QUESTION_TOOL_SET.has(tool)) {
    const answer = part.output as QuestionAnswerData | undefined;
    return answer && typeof answer === "object" && "questionText" in answer ? <AnsweredCard answer={answer} /> : null;
  }
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText}>{toolActivityLabel(tool)}</Text>
    </View>
  );
}

function AnsweredCard({ answer }: { answer: QuestionAnswerData }) {
  const picked = answer.dismissed
    ? "Skipped"
    : answer.dontKnow
      ? "I don't know"
      : [...answer.answers.map((a) => a.label), answer.other, answer.text].filter(Boolean).join(", ");
  const verdict = answer.correct === undefined ? null : answer.correct ? "Correct" : "Not quite";
  return (
    <View style={styles.card}>
      <Markdown text={answer.questionText} />
      <Text style={styles.cardAnswer}>Your answer: {unwrapPlainMath(picked)}</Text>
      {verdict && (
        <Text style={[styles.cardVerdict, { color: answer.correct ? colors.success : colors.danger }]}>{verdict}</Text>
      )}
      {answer.explanation ? <Markdown text={answer.explanation} color={colors.muted} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  userRow: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: space.lg, paddingVertical: space.sm },
  userBubble: {
    maxWidth: "85%",
    backgroundColor: colors.userBubble,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  userText: { color: colors.userText, fontSize: 16, lineHeight: 22 },
  assistant: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm },
  thinking: { color: colors.muted, fontStyle: "italic" },
  chip: {
    alignSelf: "flex-start",
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  chipText: { color: colors.muted, fontSize: 12 },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: space.md, gap: space.sm },
  cardAnswer: { color: colors.text, fontSize: 14 },
  cardVerdict: { fontSize: 14, fontWeight: "600" },
});
