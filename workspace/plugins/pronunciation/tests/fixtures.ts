/** Tiny stand-ins for the model's tokens.txt, lexicon.txt and jieba dictionaries (Baker format). */
export const TOKENS = ["  0", "_ 1", ", 2", "yin2 10", "xing2 11", "hang2 12", "ni3 13", "ni2 14", "hao3 15", "yan2 16", "jiu1 17", "sheng1 18", "ming4 19"].join("\n");
export const LEXICON = [
  "银 yin2", "行 xing2", "银行 yin2 hang2", "你 ni3", "好 hao3", "你好 ni2 hao3",
  "研 yan2", "究 jiu1", "生 sheng1", "命 ming4", "研究 yan2 jiu1", "研究生 yan2 jiu1 sheng1",
  "怪 yin2 ? xing2",
].join("\r\n");
// 生命 is only in the jieba dictionary, as in the real model files.
// 研究/生命 is more probable than 研究生/命 even though 研究生 is the longer match.
export const DICTIONARY = ["研究 1000 v", "生命 1000 n", "研究生 50 n", "命 20 n", "银行 500 n", "你好 400 l", "未知词 9 n"].join("\n");
export const USER_DICTIONARY = "银行 10000 v";
