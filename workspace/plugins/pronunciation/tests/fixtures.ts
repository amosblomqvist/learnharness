/** Tiny stand-ins for the model's tokens.txt, lexicon-zh.txt and jieba dictionaries. */
export const TOKENS = ["$ 0", "  16", "1 1", "2 2", "3 3", "4 4", "5 5", "a 43", "b 44", "c 45", "d 46", "e 47", "f 48", "g 49", "h 50"].join("\n");
export const LEXICON = [
  "银 a 2", "行 b 2", "银行 a 2 c 2", "你 d 3", "好 e 3", "你好 d 2 e 3",
  "研 f 2", "究 g 1", "生 h 1", "命 a 4", "研究 f 2 g 1", "研究生 f 2 g 1 h 1",
  "怪 a b ? c",
].join("\r\n");
// 生命 is only in the jieba dictionary, as in the real model files.
// 研究/生命 is more probable than 研究生/命 even though 研究生 is the longer match.
export const DICTIONARY = ["研究 1000 v", "生命 1000 n", "研究生 50 n", "命 20 n", "银行 500 n", "你好 400 l", "未知词 9 n"].join("\n");
export const USER_DICTIONARY = "银行 10000 v";
