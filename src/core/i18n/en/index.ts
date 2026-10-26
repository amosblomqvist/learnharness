/**
 * The English UI dictionary — the source of truth: its keys define
 * TranslationKey, and every other language's dictionary must carry
 * exactly these keys (typed as Dictionary). One file per surface.
 */

import { artifacts } from "./artifacts.ts";
import { chat } from "./chat.ts";
import { common } from "./common.ts";
import { composer } from "./composer.ts";
import { graph } from "./graph.ts";
import { nav } from "./nav.ts";
import { settings } from "./settings.ts";

export const en = { ...common, ...settings, ...nav, ...chat, ...composer, ...artifacts, ...graph };

export type TranslationKey = keyof typeof en;
export type Dictionary = Record<TranslationKey, string>;
