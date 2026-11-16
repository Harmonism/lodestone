// care.js — the second layer of the crisis gate (1.13): what the keyword gate
// (safety.js detectCrisis, exact phrases) cannot catch, because people in
// danger rarely say it outright: "everyone would be better off without me",
// "I just want to not wake up". New York's companion law (in force since
// 5 November 2025) and California's SB 243 ask for reasonable efforts to detect
// suicidal ideation and self-harm and to refer to crisis services; a list of
// phrases is not that.
//
// Two ways, both on this device, before any model sees the message:
//   meaning   the message is embedded by the model retrieval already uses
//             (multilingual-e5-small) and compared with EXAMPLES; a close
//             match is a care moment
//   phrases   INDIRECT, the commoner indirect expressions, so the layer holds
//             where the meaning model is not loaded (keyword-only devices)
//
// A care moment is not the crisis template (the keyword gate's answer, which no
// model writes): the model answers, told to ask plainly and gently about safety
// and to stay (prompt: <care_check>). Who shows the crisis line (1.13.2):
//   refer   a PLAIN phrase, said outright: the app adds the line beneath the
//           answer whatever the model writes, so that referral never depends on it
//   ask     an INDIRECT phrase or the meaning layer: neither is sure enough to
//           put a crisis line under a reader's answer on its own ("I already
//           know them", at a dinner with the wife's friends, read 0.98). The
//           model, which reads the whole conversation, decides: if the moment
//           is real it ends its reply with the care mark ([[care]], presence.js)
//           and the app puts the line for their country in its place; if not,
//           it answers as asked and nothing about safety is shown.

import { normalize as norm } from "./safety.js";

// Two kinds of phrase (1.13.1, after an audit that read them against real sentences):
//   PLAIN      said outright, unambiguous: the crisis line is shown (refer);
//   INDIRECT   said around it, and sometimes about something else ("tired of
//              living in Paris", "end it all with this company"): the model is
//              told to read it (ask), and the line is shown only if the model
//              marks the moment as real (1.13.2).
export const PLAIN = {
  ideation: [
    "i want to die", "i wanna die", "want to be dead", "wish i was dead", "wish i were dead", "thinking about suicide", "thinking of suicide", "thought about suicide",
    "i am suicidal", "i'm suicidal", "im suicidal", "i feel suicidal", "feeling suicidal", "want to kill myself", "wanna kill myself", "going to kill myself", "gonna kill myself", "i will kill myself", "i'll kill myself",
    "want to end my life", "going to end my life", "thinking of ending my life", "thinking about ending my life", "want to take my own life", "je suis suicidaire",
    "don't want to live anymore", "dont want to live anymore", "don't want to be alive", "dont want to be alive",
    "wish i had never been born", "wish i was never born", "nothing to live for", "can't go on living", "cant go on living", "goodbye letters to everyone",
    "je veux mourir", "me suicider", "je pense au suicide", "mettre fin à mes jours", "en finir avec la vie", "envie d'en finir", "je veux en finir", "plus envie de vivre",
    "quiero morir", "quiero morirme", "me quiero matar", "quiero matarme", "pienso en el suicidio", "quitarme la vida", "no quiero vivir más", "no quiero seguir viviendo",
    "أريد أن أموت", "اريد ان اموت", "أفكر في الانتحار", "افكر في الانتحار", "أريد الانتحار", "اريد الانتحار", "سأنتحر", "لا أريد أن أعيش",
    // Maghrebi darija, as typed: Arabic script, and Latin letters with 3, 7, 9 for ع, ح, ق (simulation, 15 November 2026).
    "بغيت نموت", "باغي نموت", "باغية نموت", "بغيت نقتل راسي", "ما بغيتش نعيش", "مابغيتش نعيش", "ما بقيتش باغي نعيش", "ما بقيتش باغية نعيش",
    "死んでしまいたい", "自殺を考えて", "ich denke an selbstmord", "suizidgedanken", "ich bin suizidal",
    "bghit nmout", "bghit nmot", "baghi nmout", "baghya nmout", "bghit nqtel rasi", "mabghitch n3ich", "ma bghitch n3ich", "mab9itch baghi n3ich", "mab9itch baghya n3ich",
    // Portuguese and Russian (round 3, 16 November 2026). For a native speaker's review.
    "quero morrer", "quero me matar", "vou me matar", "penso em suicídio", "pensando em suicídio", "tirar minha própria vida", "tirar a minha vida",
    "хочу умереть", "покончить с собой", "думаю о самоубийстве", "хочу убить себя",
    "आत्महत्या करना चाहत", "मैं मरना चाहत", "खुद को मार डालना चाहत",
  ],
  self_harm: [
    "been cutting myself", "keep cutting myself", "started cutting myself", "cutting myself again", "cut myself again", "cut myself on purpose",
    "hurt myself on purpose", "hurting myself again", "hurt myself again", "burned myself on purpose", "burn myself on purpose", "make myself bleed",
    "took a bunch of pills", "took too many pills", "swallowed all my pills",
    "je me scarifie", "me suis fait du mal", "me hice daño a propósito", "أؤذي نفسي", "اؤذي نفسي", "جرحت نفسي",
    "je me fais du mal", "ritze mich", "verletze mich selbst", "自分を傷つけて", "リストカット", "كنجرح راسي", "تانجرح راسي", "kanjre7 rasi", "tanjre7 rasi",
    "me cortando de novo", "me machuquei de propósito", "режу себя", "порезал себя", "порезала себя",
  ],
};
export const INDIRECT = {
  ideation: [
    "don't want to be here anymore", "dont want to be here anymore", "don't want to exist", "dont want to exist", "wish i didn't exist",
    "never wake up", "not wake up tomorrow", "go to sleep and not wake", "want it all to end", "want everything to end", "end it all", "ending it all",
    "no reason to keep living", "tired of living", "tired of being alive", "disappear forever", "disappear for good", "writing goodbye letters", "wrote goodbye letters", "giving my things away",
    "ne plus me réveiller", "ne jamais me réveiller", "fatigué de vivre", "fatiguée de vivre", "disparaître pour toujours",
    "mejor sin mí", "mejor sin mi", "no despertar nunca", "no despertar más", "acabar con todo", "no quiero vivir", "cansado de vivir", "cansada de vivir",
    "إنهاء كل شيء", "تعبت من الحياة",
    // Japanese and German (round 2, 16 November 2026: 「二人で一緒に消えてしまえたら楽なのに」 was caught by nothing). For a native speaker's review.
    "消えてしまいたい", "消えてしまえたら", "一緒に消え", "いなくなりたい", "いなくなってしまいたい", "楽になりたい", "終わりにしたい", "全部終わりにしたい", "生きるのに疲れ", "生きているのが辛い", "目が覚めなければ", "もう目覚めたくない",
    "nicht mehr aufwachen", "einfach verschwinden", "nicht mehr da sein", "will, dass alles aufhört", "will dass alles aufhört", "lebensmüde", "keinen sinn mehr zu leben", "mir etwas antun",
    // Darija: to sleep and not wake, better to die, to go with the dead and rest (the first two also said of a lie-in).
    "وما نفيقش", "ما نفيقش", "حسن لي نموت", "حسن ليا نموت", "نموت ونرتاح", "نمشي معاه ونرتاح", "نمشي معاها ونرتاح", "عييت من الحياة",
    "ma nfi9ch", "manfi9ch", "7sen li nmout", "hsen li nmout", "7sen lia nmout", "nmout w nrta7", "nmchi m3ah w nrta7", "nmchi m3aha w nrta7", "3yit mn l7ayat", "3yit mn had l7ayat",
    // Portuguese, Russian, Chinese, Hindi (round 3, 16 November 2026: "tem dias que penso que seria mais fácil não estar mais aqui" was caught by
    // nothing). Chinese "我想死" and "不想活了" are also said of embarrassment and fatigue, so they ask. For a native speaker's review.
    "não estar mais aqui", "não estar aqui mais", "mais fácil não existir", "não acordar mais", "dormir e não acordar", "sumir para sempre", "desaparecer para sempre",
    "cansado de viver", "cansada de viver", "acabar com tudo", "melhor sem mim", "não quero mais viver", "não aguento mais viver",
    "не хочу жить", "лучше бы меня не было", "лучше без меня", "уснуть и не проснуться", "устал жить", "устала жить", "исчезнуть навсегда", "покончить со всем",
    "我想死", "想自杀", "不想活", "活着没意思", "活着没什么意思", "活着有什么意思", "睡着了就再也不醒", "消失算了",
    "जीना नहीं चाहत", "मर जाना चाहत", "सब खत्म कर दू", "हमेशा के लिए गायब", "मेरे बिना सब बेहतर",
    // Plain once, moved here (1.13.2): said of a team or a meeting as well ("the team is better off without me on this").
    "better off without me", "better off if i was gone", "better off if i were gone", "better off if i wasn't here", "better off if i weren't here", "nobody would miss me if i", "mieux sans moi", "todos estarían mejor sin mí", "estarían mejor sin mí", "أفضل بدوني",
    // Plain once, moved here (1.13.1): each is also said of someone else, or as a figure of speech
    // ("my brother is suicidal", "I could kill myself laughing", "envie de mourir de rire").
    "suicidal", "kill myself", "end my life", "ending my life", "take my own life", "no reason to live", "j'ai envie de mourir", "envie de mourir",
  ],
  self_harm: [
    // "I cut myself shaving", "cutting myself some slack", "il veut me faire du mal".
    "i cut myself", "cutting myself", "je me coupe", "me corto", "me faire du mal", "hacerme daño", "je me fais mal", "je me fais un peu mal", "me machucar", "me machuco", "причиняю себе боль", "伤害自己", "खुद को चोट",
    // Chinese names the act without its subject ("我朋友自残"): asked, never shown outright.
    "自残", "割腕",
  ],
};

// Whole words only (1.13.1): "end my life" is not in "spend my life". Arabic,
// whose small words join the next ("وأريد"), is still looked for anywhere, and so are
// Japanese and Chinese, which put no space between words (16 November 2026).
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = p => /[\u0600-\u06FF\u3040-\u30FF\u4E00-\u9FFF]/.test(p) ? { test: n => n.includes(p) } : new RegExp(`(?:^|[^\\p{L}\\p{N}])${esc(p)}(?=$|[^\\p{L}\\p{N}])`, "u");
const PLAIN_N = Object.entries(PLAIN).flatMap(([kind, l]) => l.map(p => [kind, pattern(norm(p)), p]));
const INDIRECT_N = Object.entries(INDIRECT).flatMap(([kind, l]) => l.map(p => [kind, pattern(norm(p)), p]));

/** The phrase layer: { kind, how: "phrase", level, match } or null. Read whole, however long. */
export function indirectCare(text) {
  const n = norm(text);
  if (!n) return null;
  for (const [kind, p, raw] of PLAIN_N) if (p.test(n)) return { kind, how: "phrase", level: "refer", match: raw };
  for (const [kind, p, raw] of INDIRECT_N) if (p.test(n)) return { kind, how: "phrase", level: "ask", match: raw };
  return null;
}

// The meaning layer is a linear reading of the message's embedding, fitted on
// 152 sentences in English, French, Spanish and Arabic: suicidal thoughts and
// self-harm said indirectly, against ordinary talk that comes close (tired of a
// job, a grandmother's death, killing a process, the ego's death in practice,
// burning the toast). Left-one-out it caught 75 of 78 and mistook 8 of 74 hard
// ordinary sentences at 0.5; at 0.8, 3 of 74 (the data, the fit and the
// leave-one-out run in tools/care-fit/).
// Refitted in 1.13.2 with 111 short replies of ordinary conversation ("nothing
// much", "I already know them", "on est au restaurant"), which the first fit had
// none of: leave-one-out at 0.5, 72 of 78 caught and 13 of 185 ordinary
// sentences mistaken. Refitted 16 November 2026 with six more languages (German,
// Portuguese, Chinese, Japanese, Hindi, Russian; 48 such sentences of need, 53
// ordinary): leave-one-out at 0.5, 117 of 126 caught and 18 of 238 mistaken; the
// held-out twelve all caught (was 11), the 22 ordinary none, and of the 200
// simulation messages 7 asked (was 12; tools/care-fit/holdout.mjs).
// A reading this loose only ever asks:
//   ASK    (0.5) the model is told to read the moment, and to mark it if real;
//          the app shows the line only on the mark (careBlock, presence.js)
export const ASK = 0.5;
const MODEL = {"w": [-3.1887, -5.64222, 4.25936, -4.24708, 1.42097, -0.65408, 0.50037, -7.49825, -2.50599, 1.06801, -7.32237, 0.60625, -2.07558, 9.33269, -7.63778, -11.59875, 5.83834, 2.7389, -6.24685, 3.22821, 13.79132, -0.98928, -5.56605, -1.46353, 0.55461, 12.80596, 0.83089, 9.08912, 3.92484, 10.62762, -5.42899, 8.19701, -7.13528, -7.25818, 11.92945, 1.26715, 0.13957, 4.20108, 8.62263, 15.67136, 4.55487, -5.49052, 0.99411, 4.18401, -6.9937, -4.47885, -8.92326, -4.5551, 1.71499, 3.89899, -3.85443, -2.47562, 4.23498, 3.38998, 4.24046, -9.64255, -10.18584, -5.68679, 0.91897, -0.72009, 3.39288, 7.71787, -5.80846, 7.20957, 0.8393, -0.65332, 5.01742, 0.69381, 10.85533, 1.28636, 3.86129, -5.81789, -0.65752, -0.27914, -8.99749, -5.99872, -1.73913, 3.39555, 5.79889, -7.84413, 8.2245, -8.3072, 0.06959, 3.5489, 0.60549, 14.68828, 6.66294, 12.87933, -3.10554, -3.35834, 1.33768, -4.38169, -3.30694, 0.09401, -5.7845, 0.63231, 13.43767, -6.51952, 5.57298, -10.94553, -2.33961, 6.79638, 0.55733, -0.49383, 0.0611, -1.85124, 1.62648, 2.06866, 0.04928, 2.43202, -4.82081, -3.63322, -6.34462, -7.76024, 2.0823, 5.85988, 2.93357, 7.10465, -9.211, 1.45023, 0.38936, 2.62464, -3.99297, -1.85847, -10.81624, -0.27026, 1.3673, 2.05142, 3.73461, -1.49796, 10.09445, -7.90276, -2.056, 4.51703, 6.40655, -0.39905, -8.79031, -3.97666, -7.39286, -6.26164, -3.1221, -0.83649, -3.70086, -1.08552, -6.00884, -6.5907, -2.39303, 6.7057, -8.84316, -4.26252, -2.7629, -6.46684, 5.31299, -16.53259, 12.02818, 8.2888, 1.01769, -5.42235, 5.15818, -5.55774, -7.15076, -1.03459, -4.79477, 6.49335, -3.76698, -1.85776, -2.57497, 9.07888, 3.63206, -8.67669, -1.06129, 5.56526, -1.4577, -1.73746, 0.36842, 4.11925, -8.79462, 6.28525, -4.53253, -3.14001, -7.44118, -4.00341, -4.63325, 2.12791, 3.98586, -1.31492, 5.42634, -7.93234, 5.39362, 9.11386, 1.69034, 4.84303, 2.96458, 9.34724, 4.6138, -8.38409, 0.38776, -15.51117, 3.80572, 5.35366, 7.43365, -2.39724, -0.12204, -3.07676, -3.15351, 1.33533, -4.52357, 3.43768, 0.50074, 0.5807, -1.75815, -0.80661, 0.77514, 7.7929, -0.70686, -8.77491, 4.36046, 8.53981, 5.03301, 5.26071, 6.75063, 0.93911, -2.06134, 10.3323, -1.94455, -1.33066, 3.91987, 1.78558, -7.80765, -7.80404, -2.68716, 7.20292, -4.91214, 1.24863, 0.47782, -5.3505, -5.33315, 2.07736, 7.97742, 5.57349, 0.55835, -6.92138, -2.09595, 11.16521, 6.69435, -2.6993, -2.51271, -1.2445, 6.28022, 0.56257, -0.54865, 2.73619, -9.04153, -1.13705, -14.37563, 0.77116, -8.39046, -0.44971, 0.66036, 1.08692, 2.90434, 1.14879, 2.55307, -2.90554, -11.97617, 2.19147, 0.47466, 8.30621, -3.71881, 3.88972, -0.25908, -0.6377, -5.19955, 2.36897, -5.80116, 6.1287, -1.97248, -5.08481, -7.43979, -1.01934, 4.33613, 0.36167, -2.0479, 1.21389, 4.19763, 7.64828, 2.8521, 2.10623, -1.37685, -1.82697, 4.44915, 0.72987, 8.15476, 0.37934, -2.34566, -1.30622, 2.3822, -0.76216, 5.40886, 0.04756, -1.53662, 3.67081, 2.72594, 6.31796, -5.84378, -5.52694, -6.04272, -7.4126, 0.60508, -5.05414, 3.10833, -4.25362, -2.82763, 5.5104, 1.50956, -0.3682, 4.79963, 0.0193, -3.51184, -2.21271, -4.62456, 19.85721, -0.95453, -1.85775, 9.61527, -1.09334, 8.79032, 3.8552, 6.9972, -1.82435, -2.76861, 1.72143, -2.13029, -8.25729, -7.97531, 4.69564, -3.9573, -1.39609, 0.82423, 0.56967, 4.25796, 2.97706, -6.98902, 5.032, -4.00539, -0.9021, 12.54197, -8.22073, -3.15018, -6.60262, -2.31557, -4.52175, -6.8526, -4.60105, -7.46759, 1.75725, -0.14549, 2.47186, -3.37887, -3.06059, -0.16458, 3.30799, -0.78529, 0.21697, 4.00554, -3.87687, 1.08863, 8.2846, 4.00658, 5.60218, 10.9654, -7.40397, -0.39106, 5.82047, -0.57854, 12.03662, -4.20238, 2.40306, -3.97684, -4.48038, -3.16406, 1.34348, -5.56636, 8.05787], "b": -9.4667};

export function careScore(vec) {
  let z = MODEL.b;
  for (let i = 0; i < MODEL.w.length; i++) z += vec[i] * MODEL.w[i];
  return 1 / (1 + Math.exp(-z));
}

/** The meaning layer: { level: "ask", how: "meaning", score } or null. `embed`: text → normalised vector (embedder.js). */
export async function meaningCare(text, embed) {
  if (!embed || !text || text.length < 12) return null;
  // A long message is read in its parts (the model sees 512 tokens at most): the
  // end, where a journal usually arrives at what weighs, and the start.
  const parts = text.length <= 1500 ? [text] : [text.slice(-1500), text.slice(0, 1500)];
  let score = 0;
  for (const p of parts) score = Math.max(score, careScore(await embed(p)));
  if (score < ASK) return null;
  return { level: "ask", how: "meaning", score: Math.round(score * 1000) / 1000 };
}

/**
 * Both layers: a plain phrase refers at once; an indirect phrase or the meaning
 * layer asks (1.13.2), and the model's mark decides whether the line is shown.
 */
export async function careCheck(text, embed) {
  const p = indirectCare(text);
  if (p?.level === "refer") return p;
  const m = embed ? await meaningCare(text, embed).catch(() => null) : null;
  if (p) return m ? { ...p, score: m.score } : p;
  return m;
}
