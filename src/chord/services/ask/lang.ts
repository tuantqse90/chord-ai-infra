// Which language to answer in (self-test 2026-09-26: "AMD có tin gì mới không?" came back in English — every headline the
// tools returned was English and the model followed the data, not the person). The rule in the prompt stays; this pins
// it per question: Vietnamese with diacritics, or typed without them ("mua dc gi bro", "phan tich btc"), is detected in
// code and the question carries an explicit line. A language chosen in the profile still wins (it is in the system prompt).

const VI_MARKS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹàáèéìíòóùúýãõĩũ]/gi;
// Words that are Vietnamese when typed without marks and are not common English words.
const VI_BARE = /\b(khong|ko|k0|dc|duoc|phan tich|nen|mua gi|ban gi|hom nay|cho tao|cho minh|minh|tao muon|toi|con nay|coin nay|vay|the nao|nhu nao|la gi|bao nhieu|tang|giam|chot loi|cat lo|vao lenh|gia|tin gi|di bro|nhe|nha|voi)\b/gi;

// Plain English function words (eval 2026-09-28: "Quick read on BTC and ETH today…" came back in Vietnamese after the style
// gained Vietnamese heading examples — English was never pinned, so the prompt's examples could pull the model over).
const EN_WORDS = /\b(the|what|whats|what's|is|are|and|how|of|on|in|for|to|today|should|which|why|who|me|give|show|tell|about|this|that|with|it|its|do|does|can|my|your|a|an|any|week|now|price|trend|support|resistance|analyze|analyse|analysis|compare|check|find|news|best|top|worth|safe|chart|research|explain)\b/gi;

export function questionLanguage(q: string): "Vietnamese" | "English" | null {
  const letters = (q.match(/\p{L}/gu) ?? []).length;
  if (!letters) return null;
  const marks = (q.match(VI_MARKS) ?? []).length;
  if (marks >= 2 || marks / letters > 0.03) return "Vietnamese";
  const bare = new Set((q.toLowerCase().match(VI_BARE) ?? []).map((w) => w.trim()));
  if (bare.size >= 2) return "Vietnamese";
  // Only Latin letters and at least three English function words → English (Spanish / French / Indonesian questions
  // fall through to the prompt's "answer in the language of the question").
  const latinOnly = !/[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u.test(q);
  const en = new Set((q.toLowerCase().match(EN_WORDS) ?? []));
  // A short command ("Analyze NEAR Protocol", "Compare SOL and SUI") has few function words: one is enough at ≤ 5 words.
  const words = q.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
  return latinOnly && marks === 0 && (en.size >= 3 || (en.size >= 1 && words <= 5)) ? "English" : null;
}

/** The line appended to the question when the language is known and the profile does not set one. */
export const languageLine = (lang: string) => `(Answer in ${lang} — the person wrote in ${lang}, even if the data you read is in English. Keep tickers, numbers and table labels as they are.)`;
