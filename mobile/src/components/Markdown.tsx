import { Fragment } from "react";
import { View } from "react-native";
import { useMarkdown, type MarkedStyles } from "react-native-marked";
import { unwrapPlainMath } from "@/lib/plain-math";
import { colors } from "@/lib/theme";

const styles: MarkedStyles = {
  text: { fontSize: 16, lineHeight: 24, color: colors.text },
  paragraph: { paddingVertical: 2 },
  codespan: { fontFamily: "monospace", fontSize: 14, backgroundColor: colors.surface },
  code: { backgroundColor: colors.surface, padding: 8, borderRadius: 6 },
};

/** Inline markdown (no own scroll container), for use inside list rows. */
export function Markdown({ text, color }: { text: string; color?: string }) {
  const elements = useMarkdown(unwrapPlainMath(text), {
    colorScheme: "light",
    styles: color ? { ...styles, text: { ...styles.text, color } } : styles,
  });
  return (
    <View>
      {elements.map((element, i) => (
        <Fragment key={i}>{element}</Fragment>
      ))}
    </View>
  );
}
