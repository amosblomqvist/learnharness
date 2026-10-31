// The pending question's answer form: the native twin of the web's
// components/question-dock.tsx. QuestionData construction, shuffling and
// grading come from the shared core (question-core), so a mobile answer is
// byte-for-byte what the web dock would send.
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  buildAnswer,
  CONFIDENCE_STOPS,
  DEFAULT_CONFIDENCE_INDEX,
  emptyDockSelection,
  normalizeOptions,
  normalizeQuizType,
  resolveCorrect,
  seededRandom,
  shuffleOptions,
  toggleOption,
  toggleOther,
  toolQuestionKind,
  type AnswerRequest,
  type AskToolInput,
  type DockSelection,
  type ExplainToolInput,
  type PendingQuestion,
  type QuestionAnswerData,
  type QuestionData,
  type QuestionMode,
  type QuizToolInput,
  type SelectMode,
} from "@core";
import { Markdown } from "@/components/Markdown";
import { colors, radius, space } from "@/lib/theme";

interface Props {
  pending: PendingQuestion;
  disabled?: boolean;
  onSubmit: (output: QuestionAnswerData) => void;
}

function questionData(tool: string, toolCallId: string, input: QuizToolInput | AskToolInput | ExplainToolInput): QuestionData {
  const kind = toolQuestionKind(tool);
  const quizInput = kind === "quiz" ? (input as QuizToolInput) : null;
  const askInput = kind === "ask" ? (input as AskToolInput) : null;
  const explainInput = kind === "explain" ? (input as ExplainToolInput) : null;
  const multi = "multiSelect" in input ? input.multiSelect === true : false;
  const mode: QuestionMode =
    kind === "quiz"
      ? multi
        ? "multi-select"
        : "single-select"
      : askInput?.options?.length
        ? multi
          ? "multi-select"
          : "single-select"
        : "text";
  const options = normalizeOptions((quizInput?.options ?? askInput?.options ?? []) as { label: string; value?: string }[]);
  const ordered = kind === "quiz" && options.length > 0 ? shuffleOptions(options, seededRandom(toolCallId)) : options;
  const q: QuestionData = {
    id: toolCallId,
    kind,
    questionType: kind === "quiz" ? normalizeQuizType((input as { type?: unknown }).type) : undefined,
    question: input.question,
    context: input.details,
    mode,
    options: ordered,
    createdAt: new Date().toISOString(),
  };
  if (quizInput) {
    const resolved = resolveCorrect(quizInput.correctAnswer, ordered);
    if (resolved.error) console.error("[quiz] correctAnswer did not resolve:", resolved.error);
    q.correctIndices = resolved.indices;
    q.explanation = quizInput.explanation;
  }
  if (explainInput) q.committedAnswer = explainInput.correctAnswer;
  return q;
}

export function QuestionDock({ pending, disabled, onSubmit }: Props) {
  const { tool, toolCallId } = pending;
  const input = pending.input as QuizToolInput | AskToolInput | ExplainToolInput;
  const qd = useMemo(() => questionData(tool, toolCallId, input), [tool, toolCallId, input]);
  const kind = qd.kind;
  const selectMode: SelectMode = qd.mode === "multi-select" ? "multi-select" : "single-select";

  const [sel, setSel] = useState<DockSelection>(emptyDockSelection);
  const [thinking, setThinking] = useState("");
  const [other, setOther] = useState("");
  const [text, setText] = useState("");
  const [confIdx, setConfIdx] = useState(DEFAULT_CONFIDENCE_INDEX);

  const canSubmit =
    qd.mode === "text"
      ? text.trim().length > 0
      : sel.dontKnow || (sel.otherSelected && other.trim().length > 0) || sel.selected.size > 0;

  const submit = () => {
    if (!canSubmit || disabled) return;
    const req: AnswerRequest = {
      dontKnow: sel.dontKnow,
      values: [...sel.selected].map((i) => qd.options[i]!.value),
      other: sel.otherSelected ? other : undefined,
      text: qd.mode === "text" ? text : undefined,
      thinking: qd.mode !== "text" ? thinking.trim() || undefined : undefined,
      confidence: kind === "quiz" ? CONFIDENCE_STOPS[confIdx] : undefined,
    };
    onSubmit(buildAnswer(qd, req, tool));
  };

  const multi = selectMode === "multi-select";

  return (
    <View style={styles.dock}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <Markdown text={qd.question} />
        {qd.context ? <Text style={styles.context}>{qd.context}</Text> : null}

        {qd.mode !== "text" && (
          <View style={styles.options}>
            {qd.options.map((option, i) => (
              <OptionRow
                key={option.value}
                label={option.label}
                description={option.description}
                multi={multi}
                selected={sel.selected.has(i)}
                onPress={() => setSel(toggleOption(selectMode, sel, i))}
              />
            ))}
            {kind === "ask" && (
              <OptionRow
                label="Other…"
                multi={multi}
                selected={sel.otherSelected}
                onPress={() => setSel(toggleOther(selectMode, sel))}
              />
            )}
            {kind === "ask" && sel.otherSelected && (
              <TextInput style={styles.input} value={other} onChangeText={setOther} placeholder="Your answer" multiline />
            )}
            {kind === "quiz" && (
              <OptionRow
                label="I don't know"
                multi={false}
                selected={sel.dontKnow}
                onPress={() => setSel((prev) => ({ ...prev, selected: new Set(), otherSelected: false, dontKnow: !prev.dontKnow }))}
              />
            )}
          </View>
        )}

        {kind === "quiz" && !sel.dontKnow && (
          <View style={styles.confidence}>
            <Text style={styles.label}>Confidence</Text>
            <View style={styles.stops}>
              {CONFIDENCE_STOPS.map((stop, i) => (
                <Pressable
                  key={stop}
                  onPress={() => setConfIdx(i)}
                  style={[styles.stop, i === confIdx && styles.stopActive]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: i === confIdx }}
                >
                  <Text style={[styles.stopText, i === confIdx && styles.stopTextActive]}>{stop}%</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {qd.mode === "text" ? (
          <TextInput style={[styles.input, styles.tall]} value={text} onChangeText={setText} placeholder="Your answer" multiline />
        ) : (
          <TextInput style={styles.input} value={thinking} onChangeText={setThinking} placeholder="Your thinking (optional)" multiline />
        )}
      </ScrollView>

      <Pressable
        onPress={submit}
        disabled={!canSubmit || disabled}
        style={[styles.submit, (!canSubmit || disabled) && styles.submitDisabled]}
        accessibilityRole="button"
      >
        <Text style={styles.submitText}>Submit</Text>
      </Pressable>
    </View>
  );
}

function OptionRow(props: { label: string; description?: string; multi: boolean; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={props.onPress}
      style={[styles.option, props.selected && styles.optionSelected]}
      accessibilityRole={props.multi ? "checkbox" : "radio"}
      accessibilityState={{ checked: props.selected }}
    >
      <View style={[styles.mark, props.multi ? styles.markSquare : styles.markRound, props.selected && styles.markOn]} />
      <View style={styles.optionBody}>
        <Text style={styles.optionLabel}>{props.label}</Text>
        {props.description ? <Text style={styles.optionDesc}>{props.description}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dock: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.bg, maxHeight: "65%" },
  scroll: { flexGrow: 0 },
  scrollContent: { padding: space.lg, gap: space.md },
  context: { color: colors.muted, fontSize: 14 },
  options: { gap: space.sm },
  option: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  optionSelected: { borderColor: colors.accent, backgroundColor: "#EFF4FF" },
  mark: { width: 18, height: 18, borderWidth: 2, borderColor: colors.muted, marginTop: 2 },
  markRound: { borderRadius: 9 },
  markSquare: { borderRadius: 4 },
  markOn: { borderColor: colors.accent, backgroundColor: colors.accent },
  optionBody: { flex: 1, gap: 2 },
  optionLabel: { fontSize: 16, color: colors.text },
  optionDesc: { fontSize: 13, color: colors.muted },
  label: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  confidence: { gap: space.sm },
  stops: { flexDirection: "row", gap: space.xs },
  stop: { flex: 1, paddingVertical: space.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, alignItems: "center" },
  stopActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  stopText: { fontSize: 13, color: colors.text },
  stopTextActive: { color: colors.accentText, fontWeight: "600" },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.md,
    fontSize: 16,
    color: colors.text,
    minHeight: 44,
  },
  tall: { minHeight: 96, textAlignVertical: "top" },
  submit: { margin: space.lg, marginTop: 0, backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: space.md, alignItems: "center" },
  submitDisabled: { opacity: 0.4 },
  submitText: { color: colors.accentText, fontSize: 16, fontWeight: "600" },
});
