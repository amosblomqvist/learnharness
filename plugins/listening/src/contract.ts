import type { JsonValue, PluginQuestionTypeDefinition } from "learnharness-plugin-api";
import { codePointLength, LANGUAGE_TAG_PATTERN, PLAYBACK_RATES, spokenTextProblem, type PlaybackRate } from "./speech/limits.ts";
import { baseLanguage, type ModelInfo } from "./speech/provider.ts";

export const QUESTION_TYPE_ID = "listening";
export const PROBE_TOOL = "listening_probe";
export const TEACH_TOOL = "listening_question";

export type ListeningOption = { label: string; value?: string };
export type ListeningPayload = {
  audio: { text: string; language: string };
  format: "choice" | "recall";
  options?: ListeningOption[];
  explanation?: string;
  correctAnswer: string;
};
export type ListeningAnswer =
  | { status: "answered"; choice: string; playbackRates: PlaybackRate[] }
  | { status: "answered"; text: string; playbackRates: PlaybackRate[] }
  | { status: "audio_unavailable" };

/** Option keys exactly as the builtin quiz resolves them: trimmed value, else trimmed label. */
export function optionKey(option: ListeningOption): string {
  return option.value?.trim() || option.label.trim();
}

const playbackRatesSchema = {
  type: "array",
  items: { enum: [...PLAYBACK_RATES] },
  minItems: 1,
  uniqueItems: true,
  description: "Speeds at which playback started, in order of first use.",
};

export const questionSchema = {
  type: "object",
  properties: {
    audio: {
      type: "object",
      description: "The hidden spoken text. It is never shown to the learner before they answer.",
      properties: {
        text: { type: "string", pattern: "\\S", description: "Exactly what the voice should say, in the target language. Hidden until the learner answers, then shown as the transcript." },
        language: { type: "string", pattern: LANGUAGE_TAG_PATTERN, description: "ISO 639-1 code of the spoken text, such as en, es or zh, with an optional region such as pt-BR. Must be a language the configured voice model supports." },
      },
      required: ["text", "language"],
      additionalProperties: false,
    },
    format: { enum: ["choice", "recall"], description: "choice: single-answer multiple choice. recall: the learner answers in their own words." },
    options: {
      type: "array",
      minItems: 2,
      description: "choice only. The answer options (2 or more) as a JSON array of option objects. Give each a stable value and reference the correct one by that value in correctAnswer.",
      items: {
        type: "object",
        properties: {
          label: { type: "string", pattern: "\\S", description: "Learner-visible option text." },
          value: { type: "string", description: "Optional stable value; defaults to the label." },
        },
        required: ["label"],
        additionalProperties: false,
      },
    },
    explanation: { type: "string", description: "choice only, optional. Shown after the learner answers, whether right or wrong. Write it before correctAnswer: reason first, then commit." },
    correctAnswer: { type: "string", pattern: "\\S", description: "Committed before posing. choice: the value (or label) of the one correct option. recall: your full correct answer in your own words." },
  },
  required: ["audio", "format", "correctAnswer"],
  additionalProperties: false,
} as const;

export const answerSchema = {
  anyOf: [
    {
      type: "object",
      properties: { status: { const: "answered" }, choice: { type: "string", minLength: 1 }, playbackRates: playbackRatesSchema },
      required: ["status", "choice", "playbackRates"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { status: { const: "answered" }, text: { type: "string", pattern: "\\S" }, playbackRates: playbackRatesSchema },
      required: ["status", "text", "playbackRates"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { status: { const: "audio_unavailable" } },
      required: ["status"],
      additionalProperties: false,
    },
  ],
} as const;

/** Authoring problems the schema cannot express. The model limits come from the saved snapshot. */
export function questionProblems(payload: ListeningPayload, model: ModelInfo): string[] {
  const problems: string[] = [];
  const textProblem = spokenTextProblem(payload.audio.text);
  if (textProblem) problems.push(textProblem);
  const length = codePointLength(payload.audio.text);
  if (length > model.maxTextLength) problems.push(`audio.text has ${length.toLocaleString("en-US")} characters; ${model.label} accepts at most ${model.maxTextLength.toLocaleString("en-US")}.`);
  if (!model.languages.includes(baseLanguage(payload.audio.language))) {
    problems.push(`audio.language "${payload.audio.language}" is not supported by ${model.label}. Supported codes: ${model.languages.join(", ") || "none listed"}.`);
  }
  if (payload.format === "choice") {
    if (!payload.options) { problems.push("choice questions need options (2 or more)."); return problems; }
    const keys: string[] = [];
    payload.options.forEach((option, index) => {
      const key = optionKey(option);
      if (keys.includes(key)) problems.push(`options[${index}] resolves to the same value "${key}" as an earlier option; options must be distinct.`);
      keys.push(key);
    });
    if (!keys.includes(payload.correctAnswer.trim())) {
      problems.push(`correctAnswer "${payload.correctAnswer}" does not match any option value. Valid values: ${keys.map(key => `"${key}"`).join(", ")}.`);
    }
  } else {
    if (payload.options !== undefined) problems.push("recall questions take no options; use format \"choice\" for multiple choice.");
    if (payload.explanation !== undefined) problems.push("recall questions take no explanation; put your full answer and reasoning in correctAnswer.");
  }
  return problems;
}

export function answerProblems(payload: ListeningPayload, answer: ListeningAnswer): string[] {
  if (answer.status === "audio_unavailable") return [];
  if (payload.format === "choice") {
    if (!("choice" in answer)) return ["Choose one of the options."];
    if (!payload.options?.some(option => optionKey(option) === answer.choice)) return ["That option is not part of this question."];
    return [];
  }
  return "text" in answer ? [] : ["Write your answer."];
}

/** Observations for the teacher. Deterministic for choice; recall is judged by the teacher. */
export function gradeListening(payload: ListeningPayload, answer: ListeningAnswer): JsonValue {
  if (answer.status === "audio_unavailable") return { modality: "listening", outcome: "audio_unavailable", assessment: "unassessed" };
  const playback = { playbackRates: answer.playbackRates, slowPlaybackUsed: answer.playbackRates.includes(0.75) };
  if ("choice" in answer) return { modality: "listening", format: "choice", correct: answer.choice === payload.correctAnswer.trim(), ...playback };
  return { modality: "listening", format: "recall", ...playback };
}

export function readGrading(value: unknown): { correct?: boolean; outcome?: "audio_unavailable" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.correct === "boolean" ? { correct: record.correct } : {}),
    ...(record.outcome === "audio_unavailable" ? { outcome: "audio_unavailable" as const } : {}),
  };
}

const toolDescription = (phase: string) => `Pose a listening question ${phase}: the learner hears synthesized speech and answers. payload.audio.text is the hidden spoken text and payload.audio.language its ISO 639-1 code. format "choice" needs options and a correctAnswer option value; format "recall" takes a committed free-text correctAnswer. Commit the answer before posing. The learner must finish one full playback (1× or 0.75×) before submitting. You receive the answer plus playbackRates/slowPlaybackUsed, the correct flag for choice, or outcome "audio_unavailable".`;

export function listeningInstructions(model: ModelInfo): string {
  return [
    `Listening questions (${PROBE_TOOL} while probing, ${TEACH_TOOL} while teaching) let you gather evidence from listening rather than reading. For language learning, do not assume reading success establishes listening comprehension. Use listening when it serves the learning goal; it is an available capability, not a quota or a separate lesson mode.`,
    `- Put the spoken text in payload.audio.text, written exactly as it should be spoken, and its language in payload.audio.language. The configured voice model is ${model.label}; it supports these language codes: ${model.languages.join(", ") || "none listed"}. Keep the spoken text to at most ${model.maxTextLength.toLocaleString("en-US")} characters, and prefer short, natural utterances. One voice speaks; dialogues, multiple voices and multi-select are not supported.`,
    `- Choose the format that fits the goal: "choice" for single-answer multiple choice (options plus correctAnswer as the correct option's value, and an optional explanation shown after answering), or "recall" for an answer in the learner's own words (correctAnswer is your full committed answer).`,
    "- Write a visible question and, when useful, neutral context, in the language that fits the learning goal. The task must depend on the audio, not on clues that make listening unnecessary. Never print the spoken text or its translation in preceding prose, the question, options or your thinking. Do not merely ask the learner to pick a transcript unless sound-to-text recognition is the actual goal.",
    "- Commit the correct answer before posing. The transcript stays hidden until the learner submits, then it is revealed whether the answer is right or wrong. The learner may replay freely at 1× or 0.75× and must complete one full playback before submitting.",
    "- playbackRates lists the speeds at which playback started; slowPlaybackUsed: true means the learner used 0.75× support. Slow playback is valid practice: do not reduce correctness for it, and do not claim it proves normal-speed comprehension. Unlimited replay means supported listening practice, not first-hearing performance or long-term mastery.",
    "- If the result has outcome \"audio_unavailable\", the learner chose Continue another way after audio failed. Acknowledge the technical issue briefly, do not grade it or treat it as a knowledge gap, and assess the learning goal another way. A written alternative can assess related grammar or meaning; it cannot establish listening ability. Do not immediately pose another listening question that depends on the same broken playback.",
  ].join("\n");
}

export const definition = {
  id: QUESTION_TYPE_ID,
  label: "Listening question",
  contractVersion: 1,
  showThinking: true,
  questionSchema,
  answerSchema,
  probe: { toolName: PROBE_TOOL, description: toolDescription("while probing the learner") },
  teach: { toolName: TEACH_TOOL, description: toolDescription("while teaching") },
} satisfies PluginQuestionTypeDefinition;
