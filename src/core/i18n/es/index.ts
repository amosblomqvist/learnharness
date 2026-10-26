/** The Spanish UI dictionary — typed as Dictionary, so a missing key fails typecheck. */

import type { Dictionary } from "../en/index.ts";
import { artifacts } from "./artifacts.ts";
import { chat } from "./chat.ts";
import { common } from "./common.ts";
import { composer } from "./composer.ts";
import { graph } from "./graph.ts";
import { nav } from "./nav.ts";
import { settings } from "./settings.ts";

export const es: Dictionary = { ...common, ...settings, ...nav, ...chat, ...composer, ...artifacts, ...graph };
