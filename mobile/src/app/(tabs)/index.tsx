// Learn tab (Phase 0): the session list plus a composer that starts a new
// lesson — POST /api/chats, then the chat screen sends the opening message.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { ChatListItem } from "@core";
import { Composer } from "@/components/Composer";
import { stashOpening } from "@/lib/opening";
import { apiJson } from "@/lib/server";
import { colors, space } from "@/lib/theme";

export default function LearnScreen() {
  const router = useRouter();
  const chats = useQuery({
    queryKey: ["chats"],
    queryFn: () => apiJson<{ chats: ChatListItem[] }>("/api/chats").then((r) => r.chats),
  });

  const start = useMutation({
    mutationFn: (text: string) =>
      apiJson<{ id: string }>("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: text }),
      }).then((r) => ({ id: r.id, text })),
    onSuccess: ({ id, text }) => {
      stashOpening(id, text);
      router.push({ pathname: "/chat/[id]", params: { id } });
    },
  });

  const sorted = [...(chats.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <FlatList
        style={styles.flex}
        data={sorted}
        keyExtractor={(c) => c.id}
        refreshControl={<RefreshControl refreshing={chats.isRefetching} onRefresh={() => void chats.refetch()} />}
        ListEmptyComponent={
          chats.isPending ? (
            <ActivityIndicator style={styles.empty} />
          ) : chats.error ? (
            <Text style={[styles.empty, styles.error]}>{chats.error.message}</Text>
          ) : (
            <Text style={styles.empty}>No lessons yet. Say what you want to learn below.</Text>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => router.push({ pathname: "/chat/[id]", params: { id: item.id } })}
          >
            <Text style={styles.title} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={styles.meta}>
              {item.busy
                ? "Working…"
                : item.pendingQuestion
                  ? "Question waiting"
                  : new Date(item.updatedAt).toLocaleDateString()}
            </Text>
          </Pressable>
        )}
      />
      {start.error ? <Text style={[styles.error, styles.startError]}>{start.error.message}</Text> : null}
      <View>
        <Composer placeholder="What do you want to learn?" disabled={start.isPending} onSend={(t) => start.mutate(t)} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  empty: { marginTop: space.xl, textAlign: "center", color: colors.muted, paddingHorizontal: space.lg },
  error: { color: colors.danger },
  startError: { paddingHorizontal: space.lg },
  row: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 2,
  },
  title: { fontSize: 16, color: colors.text },
  meta: { fontSize: 13, color: colors.muted },
});
