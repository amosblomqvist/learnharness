// React Native adapter over the web's pure SessionModel
// (components/session-core.ts): same state machine, same wire protocol,
// with apiFetch pointing it at the harness on the LAN. Mirrors
// components/session.ts minus the browser-only window events.
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { ChatInput, LhMessage, QuestionAnswerData } from "@core";
import { SessionModel, type SessionState } from "@web/session-core";
import { apiFetch } from "@/lib/server";

export interface ChatRecord {
  messages: LhMessage[];
  turnInFlight: boolean;
  turnError?: string;
}

/** SessionModel has a single onChange slot; this owns it for one effect. */
function listen(model: SessionModel, onChange: () => void): () => void {
  model.onChange = onChange;
  return () => {
    model.onChange = undefined;
  };
}

export function useChatSession(chatId: string, record: ChatRecord) {
  // One model per mount (the screen is chatId-keyed by the route).
  const [model] = useState(
    () =>
      new SessionModel({
        chatId,
        initialMessages: record.messages,
        initialError: record.turnError,
        fetch: apiFetch,
      }),
  );

  const [version, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => listen(model, bump), [model]);

  // The reattach stream's settled terminal: adopt the saved record, then run
  // any continuation the agent is owed (same seam as chat.tsx syncFromServer).
  useEffect(() => {
    model.setReattachSettled(() => {
      void (async () => {
        const res = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}`);
        if (!res.ok) return;
        const fresh = (await res.json()) as Partial<ChatRecord>;
        if (!Array.isArray(fresh.messages)) return;
        model.setMessages(fresh.messages, fresh.turnError);
        void model.continueIfOwed(fresh.messages);
      })();
    });
  }, [model, chatId]);

  // Mount: reattach to a running turn, or run an owed continuation. Unmount
  // releases the stream; the turn keeps running server-side.
  useEffect(() => {
    if (record.turnInFlight) void model.resumeStream(false);
    else void model.continueIfOwed(record.messages);
    return () => model.stop();
    // mount-only: the record seeds the model once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const state = useMemo<SessionState>(() => model.getState(), [model, version]);

  const send = useCallback((input: ChatInput, onAccepted?: () => void) => model.send(input, onAccepted), [model]);
  const submitAnswer = useCallback(
    (tool: string, toolCallId: string, output: QuestionAnswerData, questionKey?: string) =>
      void model.submitAnswer(tool, toolCallId, output, questionKey),
    [model],
  );
  const steer = useCallback((text: string) => void model.steer(text), [model]);
  const stop = useCallback(() => model.stop(), [model]);
  const clearError = useCallback(() => model.clearError(), [model]);

  return { ...state, send, submitAnswer, steer, stop, clearError };
}
