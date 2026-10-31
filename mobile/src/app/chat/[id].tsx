// The chat screen: loads the record, then hands it to the shared session
// state machine (useChatSession). A pending question replaces the composer
// with the question dock, as on the web.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { findPendingToolCall, pendingQuestionOf } from "@core";
import { Composer } from "@/components/Composer";
import { MessageView } from "@/components/MessageView";
import { QuestionDock } from "@/components/QuestionDock";
import { takeOpening } from "@/lib/opening";
import { apiJson } from "@/lib/server";
import { colors, space } from "@/lib/theme";
import { useChatSession, type ChatRecord } from "@/lib/use-chat-session";

type ChatResponse = ChatRecord & { title: string };

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const record = useQuery({
    queryKey: ["chat", id],
    queryFn: () => apiJson<ChatResponse>(`/api/chats/${encodeURIComponent(id)}`),
    // The session model owns live state after the first load.
    staleTime: Infinity,
    gcTime: 0,
  });

  if (record.isPending) return <ActivityIndicator style={styles.center} />;
  if (record.error) return <Text style={[styles.center, styles.error]}>{record.error.message}</Text>;
  return (
    <>
      <Stack.Screen options={{ title: record.data.title }} />
      <ChatSession chatId={id} record={record.data} />
    </>
  );
}

function ChatSession({ chatId, record }: { chatId: string; record: ChatRecord }) {
  const queryClient = useQueryClient();
  const session = useChatSession(chatId, record);
  const { messages, nativeMessages, status, error } = session;
  const running = status === "submitted" || status === "streaming";
  const pending = running ? null : findPendingToolCall(messages, pendingQuestionOf(nativeMessages));

  // A new lesson's opening message, stashed by the Learn tab.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const opening = takeOpening(chatId);
    if (opening && !record.messages.some((m) => m.role === "user" || m.role === "assistant")) {
      void session.send({ type: "text", text: opening });
    }
    // mount-only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the Learn tab's list fresh when a turn settles.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void queryClient.invalidateQueries({ queryKey: ["chats"] });
    wasRunning.current = running;
  }, [running, queryClient]);

  const list = useRef<FlatList>(null);

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <FlatList
        ref={list}
        style={styles.flex}
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <MessageView message={item} />}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        ListFooterComponent={status === "submitted" ? <ActivityIndicator style={styles.spinner} /> : undefined}
      />
      {error ? (
        <View style={styles.errorBar}>
          <Text style={styles.error}>{error.message}</Text>
          <Pressable onPress={() => void session.send({ type: "retry" })}>
            <Text style={styles.retry}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      {pending ? (
        <QuestionDock
          key={pending.key}
          pending={pending}
          onSubmit={(output) => session.submitAnswer(pending.tool, pending.toolCallId, output, pending.key)}
        />
      ) : (
        <Composer
          placeholder={running ? "Add to this turn…" : "Message"}
          onSend={(text) => (running ? session.steer(text) : void session.send({ type: "text", text }))}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, marginTop: space.xl, textAlign: "center" },
  spinner: { marginVertical: space.md },
  error: { color: colors.danger },
  errorBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, padding: space.md, backgroundColor: "#FEF2F2" },
  retry: { color: colors.accent, fontWeight: "600" },
});
