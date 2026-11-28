'use strict';
/** Host interface language in the backend: LH_LANG from the host server. */
function tr(zh, en) {
  return process.env.LH_LANG === 'en' ? en : zh;
}
module.exports = { tr };
