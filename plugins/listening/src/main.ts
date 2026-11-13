import type { PluginFrontendContext, PluginQuestionRenderer } from "learnharness-plugin-api";
import { decodeAudio } from "./audio-control.ts";
import { QUESTION_TYPE_ID, type ListeningAnswer, type ListeningPayload } from "./contract.ts";
import { mountAnswerEditor } from "./editor.ts";
import { createPlaybackStore } from "./playback-state.ts";
import { stopActivePlayback } from "./player.ts";
import { mountSettings } from "./settings-view.ts";
import { mountAnswered, mountQuestion } from "./views.ts";

export function activate(ctx: PluginFrontendContext): () => void {
  const store = createPlaybackStore();
  // The key stays in the backend; audio comes back as base64 over the JSON bridge.
  const load = async (text: string, language: string) => decodeAudio(await ctx.call("synthesize", { text, language }));
  const unregisterQuestion = ctx.registerQuestionRenderer({
    id: QUESTION_TYPE_ID,
    supportedContractVersions: [1],
    mountQuestion: (container, props) => mountQuestion(container, props, { ui: ctx.ui, load, store }),
    mountAnswerEditor: (container, props) => mountAnswerEditor(container, props, store),
    mountAnswered: (container, props) => mountAnswered(container, props, { ui: ctx.ui, load }),
  } satisfies PluginQuestionRenderer<ListeningPayload, ListeningAnswer>);
  const unregisterSettings = ctx.registerSettings((container, signal) => mountSettings(container, signal, ctx));
  return () => {
    try { unregisterSettings(); }
    finally {
      try { unregisterQuestion(); }
      finally { stopActivePlayback(); store.clear(); }
    }
  };
}
