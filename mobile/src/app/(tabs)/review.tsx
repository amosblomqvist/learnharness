import { StyleSheet, Text, View } from "react-native";

export default function ReviewScreen() {
  return (
    <View style={styles.container}>
      <Text>Review</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center" },
});
