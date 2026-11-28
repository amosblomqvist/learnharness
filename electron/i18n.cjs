"use strict";
/** Shell-side tr(): main reads settings.general.language into LH_LANG at startup
 *  (see src/core/i18n.ts); the spawned server inherits it. */
function tr(zh, en) {
	return process.env.LH_LANG === "en" ? en : zh;
}
module.exports = { tr };
