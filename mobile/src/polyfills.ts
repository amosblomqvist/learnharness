// Web globals the shared harness code (../src/core) expects but Hermes
// lacks. Imported first by the root layout.
import { getRandomValues, randomUUID } from "expo-crypto";

// core/native-messages.ts mints message ids with crypto.randomUUID().
if (typeof globalThis.crypto?.randomUUID !== "function") {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { ...globalThis.crypto, randomUUID, getRandomValues },
  });
}
