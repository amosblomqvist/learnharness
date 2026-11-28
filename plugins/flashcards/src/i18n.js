/** Host interface language: <html lang> in the page (LH_LANG outside one). */
export function tr(zh, en) {
  const lang = (typeof document !== 'undefined' && document.documentElement?.lang)
    || (typeof process !== 'undefined' && process.env?.LH_LANG) || 'zh';
  return lang.toLowerCase().startsWith('en') ? en : zh;
}
