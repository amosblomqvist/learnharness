import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors, radius, space } from "@/lib/theme";

interface Props {
  placeholder: string;
  disabled?: boolean;
  onSend: (text: string) => void;
}

export function Composer({ placeholder, disabled, onSend }: Props) {
  const [text, setText] = useState("");
  const canSend = !disabled && text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <View style={styles.row}>
      <TextInput style={styles.input} value={text} onChangeText={setText} placeholder={placeholder} multiline editable={!disabled} />
      <Pressable onPress={send} disabled={!canSend} style={[styles.send, !canSend && styles.sendDisabled]} accessibilityLabel="Send">
        <Ionicons name="arrow-up" size={20} color={colors.accentText} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.sm,
    padding: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  input: {
    flex: 1,
    maxHeight: 140,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: 16,
    color: colors.text,
  },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  sendDisabled: { opacity: 0.4 },
});
