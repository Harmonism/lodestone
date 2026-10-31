// route.js — how much depth a turn needs (v107).
// A port of MunAI on Telegram's router (harmonia-astro/telegram-companion/companion-classifier.php),
// which ran Haiku for greetings and short exchanges and Opus for everything that matters.
// Here it decides two things: in the hybrid, which model answers (the chosen one, or a light
// model of the same maker); and for any untested thinking model, how much it deliberates.
// It errs toward depth: a turn it cannot place is "ask" (the light model classifies it, and a
// failure counts as deep), and every sign of a person in difficulty is deep at once.

const GREETINGS = new Set(["hi", "hello", "hey", "bonjour", "salut", "salam", "hola", "coucou",
  "good morning", "good evening", "good night", "bonsoir", "bonne nuit",
  "thanks", "thank you", "thanks a lot", "merci", "merci beaucoup", "shukran", "gracias",
  "ok", "okay", "d'accord", "got it", "understood", "noted", "cool", "parfait",
  "bye", "goodbye", "see you", "take care", "à bientôt", "a bientot", "à demain",
  "yes", "no", "oui", "non", "yeah", "nah", "yep", "nope", "ouais",
  "good", "great", "perfect", "nice", "interesting", "super", "génial", "top",
  "👍", "🙏", "❤️", "😊", "✅"]);

const DOCTRINAL = ["logos", "dharma", "ṛta", "rta", "absolute", "absolu", "presence", "présence", "harmonism", "harmonis",
  "harmonic", "harmoni", "wheel", "roue", "realism", "réalisme", "void", "vide", "cosmos", "cartograph",
  "enneagram", "ennéagramme", "ayni", "munay", "jing", "qi", "shen", "chakra", "soul", "âme", "spirit", "esprit", "karma"];

const DEEP = ["suffering", "crisis", "struggling", "lost", "confused", "anxious", "depressed", "lonely", "broken", "stuck",
  "purpose", "meaning", "death", "dying", "grief", "relationship", "divorce", "separation", "family",
  "meditation", "practice", "protocol", "supplement", "fasting", "sleep", "diagnosis", "symptom", "dose", "medication",
  "vaccine", "vaccination", "terrain", "tetanus", "rabies", "antivenom", "bite", "puncture", "wound", "pain",
  "god", "afterlife", "reincarnation", "enlighten", "money", "invest", "bitcoin", "career", "marriage", "child",
  "what is the purpose", "how should i live", "why am i", "what should i", "help me understand", "i feel", "i am feeling", "i'm feeling",
  "souffr", "je me sens", "perdu", "angoiss", "déprim", "deprim", "seul", "sens de", "mort", "deuil", "couple", "famille",
  "méditation", "pratique", "protocole", "complément", "jeûne", "sommeil", "douleur", "dieu", "argent", "enfant"];

const GUIDANCE = ["what do you think", "what would you", "how do i", "how can i", "where should i", "tell me about", "explain",
  "according to", "which pillar", "my wheel", "my profile", "assess", "guidance", "advice", "recommend", "should i",
  "que penses-tu", "qu'en penses", "qu'est-ce que", "explique", "conseil", "dois-je", "comment"];

const words = s => (s.match(/[\p{L}\p{N}'’-]+/gu) || []).length;

/**
 * { depth: "light" | "deep" | "ask", reason }.
 * `first`: the first message of the conversation; `retrying`: Try again on an answer;
 * `heavy`: files, images, a page or a web lookup ride with the turn;
 * `witness`, `care`: the safety layers marked the moment.
 */
export function routeTurn(text, { first = false, retrying = false, heavy = false, witness = false, care = false } = {}) {
  const msg = String(text || "").trim(), low = msg.toLowerCase(), bare = low.replace(/[!.?…,\s]+$/u, "").replace(/^[\s,]+/, "");
  if (witness || care) return { depth: "deep", reason: "care" };
  if (first) return { depth: "deep", reason: "opening" };
  if (retrying) return { depth: "deep", reason: "retry" };
  if (heavy) return { depth: "deep", reason: "attachments" };
  if (/^HP::/.test(msg)) return { depth: "deep", reason: "assessment" };
  const n = words(msg);
  if (n >= 50) return { depth: "deep", reason: "long" };
  if (GREETINGS.has(low) || GREETINGS.has(bare)) return { depth: "light", reason: "greeting" };
  const doctrinal = DOCTRINAL.find(k => low.includes(k));
  if (n <= 3 && !doctrinal && !msg.includes("?")) return { depth: "light", reason: "short" };
  const deep = DEEP.find(k => low.includes(k));
  if (deep) return { depth: "deep", reason: `signal:${deep}` };
  if (doctrinal) return { depth: "deep", reason: `doctrine:${doctrinal}` };
  const g = GUIDANCE.find(k => low.includes(k));
  if (g) return { depth: "deep", reason: `guidance:${g}` };
  return { depth: "ask", reason: "unclear" };
}

/** The classifier's instruction, as on Telegram. */
export const CLASSIFIER_PROMPT = `You are a message router for a philosophical guidance system. Classify the user's message as SIMPLE or DEEP.

SIMPLE: greetings, thanks, acknowledgments, "how are you", casual remarks, simple factual questions about navigation or the app, messages that need only a brief friendly response.

DEEP: questions about philosophy, meaning, purpose, suffering, death, relationships, health protocols, personal struggles, doctrinal positions, requests for guidance or assessment, emotional disclosures, anything requiring nuanced or personalized response.

Respond with ONLY the word SIMPLE or DEEP. Nothing else.`;
