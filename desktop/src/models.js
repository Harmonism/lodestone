// models.js — the models Lodestone can run, and which one suits this computer.
//
// Source: World/Frontiers/"Uncensored AI Models — A Ranking by the Hand That
// Remains" (28 Sep 2026), re-read against the UGI leaderboard CSV of 24 Sep 2026
// in Lodestone's own operating mode: thinking off, 32k-token window (the full
// doctrinal backbone is ~17,500 tokens; the window holds it plus retrieval plus
// the conversation).
//
// Minimum (29 Sep 2026): the Gemma 3 12B class, which needs 16 GB of memory.
// Below that class answers misrepresent the system often enough that no answer
// is better; Qwen3.5 9B (NatInt 16.1 with thinking off) was withdrawn for that.
//
// `ugi` is always the thinking-off row: { w: willingness /10, natint, lean },
// with `base` the unmodified original. The doctrinal probe that would rank these
// on Harmonist ground is still unbuilt; every default is provisional on it.
//
// Each entry is one or more GGUF files on Hugging Face, downloaded by the app
// and checked against the SHA-256 Hugging Face publishes for each. A model split
// into shards (-00001-of-0000N.gguf) is loaded from its first shard; llama.cpp
// finds the rest beside it. Sizes and hashes read from the HF API, 29 Sep 2026.
//
// `mmproj` is the model's vision projector (its "eyes"), downloaded only when the
// practitioner first attaches an image, and passed to the engine with --mmproj.
// Read from the HF API on 8 Oct 2026.

const BUNDLED = [
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash · unmodified",
    repo: "unsloth/DeepSeek-V4-Flash-GGUF",
    files: [
      { path: "UD-Q4_K_XL/DeepSeek-V4-Flash-UD-Q4_K_XL-00001-of-00005.gguf", size: 5256608, sha256: "0cecd47692e23e39de16598a4b40c4e1e53a3f2f56a965cc419fc136e9801494" },
      { path: "UD-Q4_K_XL/DeepSeek-V4-Flash-UD-Q4_K_XL-00002-of-00005.gguf", size: 48935523072, sha256: "1f7a6e3b8f2f4eb37ffb261c1e0d1e9784a9bb53f34a576cc475d55b67c275b8" },
      { path: "UD-Q4_K_XL/DeepSeek-V4-Flash-UD-Q4_K_XL-00003-of-00005.gguf", size: 48980787136, sha256: "bb8080adaaa52b4bc8b51e9316c85e9e28933f0e70ae817473711fa8dbe9690d" },
      { path: "UD-Q4_K_XL/DeepSeek-V4-Flash-UD-Q4_K_XL-00004-of-00005.gguf", size: 49999168416, sha256: "4b7be9d4d07c573525a15f2899a1193e3b2699dc59345d6d73ef2118c546c8f3" },
      { path: "UD-Q4_K_XL/DeepSeek-V4-Flash-UD-Q4_K_XL-00005-of-00005.gguf", size: 7174505088, sha256: "60fb82d6e1651544f8b1d44eb7eaf8bd20b5e70a855f5c04044f82750a5bfb20" },
    ],
    minMem: 240, hand: "DeepSeek",
    ugi: { w: 7.2, natint: 47.9, lean: -13.9 },
    why: "The most capable open model that answers contested questions without any refusal removal. 284 billion parameters, 13 billion active per word. For Mac Studios and workstations with 256 GB of memory.",
  },
  {
    id: "glm45-air",
    retired: true,   // off the offered list since 15 Oct 2026; kept for those who have it
    label: "GLM-4.5-Air · uncensored (Derestricted)",
    repo: "bartowski/ArliAI_GLM-4.5-Air-Derestricted-GGUF",
    files: [
      { path: "ArliAI_GLM-4.5-Air-Derestricted-Q4_K_M/ArliAI_GLM-4.5-Air-Derestricted-Q4_K_M-00001-of-00002.gguf", size: 39831457056, sha256: "00eac2b5b2635feeb11e54e8f997cc4f4ff72701e435bd461c9d8f749a02e45b" },
      { path: "ArliAI_GLM-4.5-Air-Derestricted-Q4_K_M/ArliAI_GLM-4.5-Air-Derestricted-Q4_K_M-00002-of-00002.gguf", size: 33670479648, sha256: "b6d95dd26be6c9efb16f883cfdb5f30809d0ab29f38d66152bc2667ee5b94c30" },
    ],
    minMem: 120, hand: "Zhipu",
    ugi: { w: 7.8, natint: 27.5, lean: -9.9, base: { w: 7.0, natint: 32.2, lean: -20.2 } },
    why: "A non-Western lineage for 128 GB machines. With thinking off, as Lodestone runs, it scores below Gemma 4 26B: choose it for its lineage and its place near the political centre, not for strength.",
  },
  {
    id: "gemma4-26b-heretic-q8",
    retired: true,   // off the offered list since 15 Oct 2026; kept for those who have it
    label: "Gemma 4 26B · uncensored, high precision",
    repo: "mradermacher/gemma-4-26B-A4B-it-uncensored-heretic-GGUF",
    files: [{ path: "gemma-4-26B-A4B-it-uncensored-heretic.Q8_0.gguf", size: 26859855072, sha256: "a2fa600d33d4ef3449217a58bf5bdb890ee985c3d7700c7e56243f575ab7ecd2" }],
    mmproj: { repo: "mradermacher/gemma-4-26B-A4B-it-uncensored-heretic-GGUF", path: "gemma-4-26B-A4B-it-uncensored-heretic.mmproj-Q8_0.gguf", size: 806408512, sha256: "be045b816757d9e4f1edc1bcf80244306b4e7c8f3b0ec661594d1a6774d2296c" },
    minMem: 60, hand: "Google",
    ugi: { w: 9.2, natint: 34.1, lean: -22.2, base: { w: 1.8, natint: 34.4, lean: -18.2 } },
    why: "Gemma 4 26B at 8-bit precision, closer to the original weights. For computers with 64 GB or more.",
  },
  {
    id: "gemma4-26b-heretic",
    label: "Gemma 4 26B · uncensored",
    repo: "mradermacher/gemma-4-26B-A4B-it-uncensored-heretic-GGUF",
    files: [{ path: "gemma-4-26B-A4B-it-uncensored-heretic.Q4_K_M.gguf", size: 16796011744, sha256: "0e345c1fbb9f376828c5c3a986c62f6b4b0934e32cf57238ff8960529417d9fb" }],
    mmproj: { repo: "mradermacher/gemma-4-26B-A4B-it-uncensored-heretic-GGUF", path: "gemma-4-26B-A4B-it-uncensored-heretic.mmproj-Q8_0.gguf", size: 806408512, sha256: "be045b816757d9e4f1edc1bcf80244306b4e7c8f3b0ec661594d1a6774d2296c" },
    minMem: 32, hand: "Google",
    ugi: { w: 9.2, natint: 34.1, lean: -22.2, base: { w: 1.8, natint: 34.4, lean: -18.2 } },
    why: "For 32 GB computers. Only 4 billion of its 26 billion parameters work on each word, so it answers quickly; it held Lodestone's doctrine in Harmonia's tests.",
  },
  {
    id: "gemma4-26b-sompoa",
    retired: true,   // off the offered list since 15 Oct 2026; kept for those who have it
    label: "Gemma 4 26B · uncensored, centred",
    repo: "mradermacher/gemma-4-26B-A4B-it-SOMPOA-heresy-GGUF",
    files: [{ path: "gemma-4-26B-A4B-it-SOMPOA-heresy.Q4_K_M.gguf", size: 16796016096, sha256: "78530c2e42963621b4f2b9de8fc938775ad25b4e1c0a009c4d314c255d95d33b" }],
    mmproj: { repo: "mradermacher/gemma-4-26B-A4B-it-SOMPOA-heresy-GGUF", path: "gemma-4-26B-A4B-it-SOMPOA-heresy.mmproj-Q8_0.gguf", size: 806408512, sha256: "c15d39331ebf011cb7506dba8724e5ce9de275fad00803bb6794fb313fb2f6d4" },
    minMem: 32, hand: "Google",
    ugi: { w: 8.0, natint: 34.7, lean: -9.4, base: { w: 1.8, natint: 34.4, lean: -18.2 } },
    why: "The same model, uncensored differently: its political score moves toward the centre instead of away from it, at the cost of refusing a little more.",
  },
  // Added 15 Oct 2026 after the doctrinal-fidelity suite on backbone 2.8
  // (System Reports/Lodestone Fidelity Suite — 2026-10-15-1700…1707), run on the
  // original weights through OpenRouter: each held the backbone's positions across
  // the eleven questions, twice, autism within the corpus's tiers both times. Unmodified, so the file is the
  // tested model, compressed to four bits. Sizes and hashes from the HF API.
  {
    id: "qwen35-35b-a3b",
    label: "Qwen 3.5 35B · unmodified",
    repo: "unsloth/Qwen3.5-35B-A3B-GGUF",
    files: [{ path: "Qwen3.5-35B-A3B-Q4_K_M.gguf", size: 22016023168, sha256: "3b46d1066bc91cc2d613e3bc22ce691dd77e6f0d33c9060690d24ce6de494375" }],
    mmproj: { repo: "unsloth/Qwen3.5-35B-A3B-GGUF", path: "mmproj-F16.gguf", size: 899283648, sha256: "a516ab92e8240da4734d68352bdfba84c16e830ee40010b8fac80d69c77272ff" },
    minMem: 48, hand: "Alibaba",
    why: "For 48 GB computers and up. The most faithful to Lodestone's doctrine in Harmonia's tests, autism included, where most models fall back on the consensus. Only 3 billion of its 35 billion parameters work on each word, so it answers quickly.",
  },
  {
    id: "qwen35-27b",
    retired: true,   // off the offered list since 15 Oct 2026; kept for those who have it
    label: "Qwen 3.5 27B · unmodified",
    repo: "unsloth/Qwen3.5-27B-GGUF",
    files: [{ path: "Qwen3.5-27B-Q4_K_M.gguf", size: 16740812704, sha256: "84b5f7f112156d63836a01a69dc3f11a6ba63b10a23b8ca7a7efaf52d5a2d806" }],
    mmproj: { repo: "unsloth/Qwen3.5-27B-GGUF", path: "mmproj-F16.gguf", size: 927607040, sha256: "458bc46d8f275866fde5d88c9c554d9d462a6e8e3a028090d9850e17ab6a1217" },
    minMem: 32, hand: "Alibaba",
    why: "The most faithful to Lodestone's doctrine of the models a 32 GB computer can hold, in Harmonia's tests. Every parameter works on every word, so it is slower than Gemma 4 26B.",
  },
  {
    id: "ministral-14b",
    label: "Ministral 3 14B · unmodified",
    repo: "mistralai/Ministral-3-14B-Instruct-2512-GGUF",
    files: [{ path: "Ministral-3-14B-Instruct-2512-Q4_K_M.gguf", size: 8239593024, sha256: "824e0f3373e69b84f2cae46fdcb9bd1ebc6ab3bfc7acc125d818b7b8178cc613" }],
    mmproj: { repo: "mistralai/Ministral-3-14B-Instruct-2512-GGUF", path: "Ministral-3-14B-Instruct-2512-BF16-mmproj.gguf", size: 879258784, sha256: "ab7616148b7081030fd38e410c9213ce8346a8b0588291c8ca279058e78cfae7" },
    minMem: 16, hand: "Mistral",
    why: "For 16 and 24 GB computers. Held Lodestone's doctrine in every test, and answered on topic where Gemma 3 12B sometimes recited doctrine instead. A European lineage, from Mistral's own files.",
  },
  {
    id: "gemma3-12b",
    retired: true,   // off the offered list since 15 Oct 2026; kept for those who have it
    label: "Gemma 3 12B · uncensored",
    repo: "mradermacher/gemma-3-12b-it-norm-preserved-biprojected-abliterated-GGUF",
    files: [{ path: "gemma-3-12b-it-norm-preserved-biprojected-abliterated.Q4_K_M.gguf", size: 7300778976, sha256: "d04639b1f492778af86f13c64c560f6b39c815b85b8473002e700e958aa22929" }],
    mmproj: { repo: "ggml-org/gemma-3-12b-it-GGUF", path: "mmproj-model-f16.gguf", size: 854200224, sha256: "30c02d056410848227001830866e0a269fcc28aaf8ca971bded494003de9f5a5" },   // the base model's projector: the abliterated repo has none, and abliteration leaves the vision tower untouched
    minMem: 16, hand: "Google",
    ugi: { w: 9.2, natint: 21.3, lean: -6.4, base: { w: 3.0, natint: 18.7, lean: -11.7 } },
    why: "Lodestone's minimum standard, for 16 GB computers. Uncensoring it made it more capable, and moved it toward the political centre.",
  },
  // Added 18 Oct 2026 at Tahir's request, offered as untested; recommended from 16 GB up to 45 GB since 19 Oct; about 5.8 GB resident when loaded.
  // Ternary weights (PTQ1_0) that only the Prism ML fork of llama.cpp can run, so
  // this entry carries `engine: "prism"`: the first time it is downloaded, that
  // engine is fetched too (PRISM_ENGINE below) and the model runs on it alone.
  // Not through the fidelity suite: its calls timed out on 15 Oct, and its
  // base, Qwen3.8-27B, gave the consensus answer on autism twice.
  // Sizes and hashes from the HF API, 18 Oct 2026; the PTQ1_0 hash re-computed
  // on the downloaded file.
  {
    id: "bonsai2-27b-heretic",
    untested: true,
    engine: "prism",
    label: "Bonsai 2 27B · uncensored (Heretic), ternary",
    repo: "OS-Software/Ternary-Bonsai-2-27B-Uncensored-Heretic-GGUF",
    files: [{ path: "Ternary-Bonsai-2-27B-Uncensored-Heretic-PTQ1_0.gguf", size: 5946648928, sha256: "a18c3e17da397838305522b3ee877f9d2cbf4facd04ba01a394b22f3f3a477be" }],
    mmproj: { repo: "OS-Software/Ternary-Bonsai-2-27B-Uncensored-Heretic-GGUF", path: "mmproj-Q8_0.gguf", size: 629246976, sha256: "6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903" },
    minMem: 16, hand: "PrismML, on Alibaba's Qwen",
    why: "A 27-billion-parameter model compressed to ternary weights, so it fits in 6 GB and runs on a 16 GB laptop. Not yet tested against Lodestone's doctrine: the model it was built from gave the consensus answer on autism in Harmonia's tests. It runs on a second engine, Prism ML's, downloaded with it (about 12–36 MB).",
  },
  // Added 19 Oct 2026 at Tahir's request, for computers under 16 GB: the
  // only Bonsai that fits them. Prism ML's own ternary packing of Qwen 3.5 9B, the
  // base withdrawn from this list on 29 Sep for answers that misrepresented the
  // system; so it is labelled smaller and weaker as well as untested, and the
  // welcome still offers DeepSeek V4.1 Flash first. Sizes and hashes from the HF
  // API, 19 Oct 2026; the PTQ1_0 hash re-computed on the downloaded file.
  {
    id: "bonsai2-9b",
    untested: true,
    weaker: true,
    engine: "prism",
    label: "Bonsai 2 9B · unmodified, ternary",
    repo: "prism-ml/Ternary-Bonsai-2-9B-gguf",
    files: [{ path: "Ternary-Bonsai-2-9B-PTQ1_0.gguf", size: 1997486976, sha256: "3561df7ac7d26a71ffa991ac2db740b10841c3a350aa2676ccd3ff5d428b4e8b" }],
    mmproj: { repo: "prism-ml/Ternary-Bonsai-2-9B-gguf", path: "Ternary-Bonsai-2-9B-mmproj-Q8_0.gguf", size: 624229664, sha256: "e0cb6f6988cea323ef798cd77d019bbb819af75582f034eaab0e7232314953db" },
    minMem: 8, hand: "PrismML, on Alibaba's Qwen",
    why: "For computers with less than 16 GB of memory: a 9-billion-parameter model in 2 GB. Smaller and weaker than the models above, and not yet tested against Lodestone's doctrine; the model it was built from, Qwen 3.5 9B, was withdrawn from Lodestone for answers that misrepresented the system. If the internet is at hand, DeepSeek V4.1 Flash through your account or your own key answers far better. It runs on Prism ML's engine, downloaded with it.",
  },
];

// The engine for `engine: "prism"` models: Prism ML's fork of llama.cpp, which
// adds the ternary kernels mainline llama.cpp lacks (PTQ1_0, PQ2_0). The same
// build Lode desktop runs (engines/prism-darwin-arm64: its llama-server is
// byte-identical to this release's macOS arm64 one), where Bonsai first ran on
// the Mac. Not bundled: fetched from the fork's GitHub release only when such a
// model is first needed, checked against the SHA-256 GitHub publishes for each
// asset (re-computed on the downloaded archives, 18 Oct 2026), and unpacked into
// the data folder. One build per platform the app ships, the same back-ends as
// the bundled engine: Metal on Apple silicon, Vulkan on Windows and Linux.
const PRISM_ENGINE = {
  tag: "prism-b10772-e8fd209",
  assets: {
    "darwin-arm64": { name: "llama-prism-b10772-e8fd209-bin-macos-arm64.tar.gz", size: 11534167, sha256: "b4cbf62095ab7f30bf5a5c457e415090777a8d185986300978ca297d88f9b7a3" },
    "darwin-x64": { name: "llama-prism-b10772-e8fd209-bin-macos-x64.tar.gz", size: 11573384, sha256: "be57416ed344bf0415a23400e772d6ce9e329d2854e77fa0f94bd9e3af03598a" },
    "linux-x64": { name: "llama-prism-b10772-e8fd209-bin-ubuntu-vulkan-x64.tar.gz", size: 35857261, sha256: "bf0849e2ad6ca39aed5338ab6072ea10f83c9ab28e30e1f34b553b87550af16e" },
    "win32-x64": { name: "llama-prism-b10772-e8fd209-bin-win-vulkan-x64.zip", size: 31242630, sha256: "f365ad7c56fb9df8805eb4f701bd068ee36c61da894dc7c52f48644d1fa2b625" },
  },
};
/** This computer's Prism engine archive, with its download address, or null. */
function prismAsset(platform = process.platform, arch = process.arch) {
  const a = PRISM_ENGINE.assets[`${platform}-${arch}`];
  return a ? { ...a, url: `https://github.com/PrismML-Eng/llama.cpp/releases/download/${PRISM_ENGINE.tag}/${a.name}` } : null;
}

// A test-only entry, never shown: MUNAI_TEST_MODEL=tiny exercises the whole
// download → engine → conversation path with a 0.5 GB file.
if (process.env.MUNAI_TEST_MODEL === "tiny") BUNDLED.push({
  id: "tiny", label: "Test model (0.8B)", repo: "mradermacher/Qwen3.5-0.8B-heretic-v2-GGUF",
  files: [{ path: "Qwen3.5-0.8B-heretic-v2.Q4_K_M.gguf", size: 527503872, sha256: "433f5d53ff18ea9f07f825112206c3b64556a2d24eaa1af84873b251fdd484df" }],
  minMem: 1, hand: "Alibaba", why: "For testing the app only.",
});

const MIN_MEM = 16;
/** The least memory any model offered on this computer needs: 8 GB where Prism ML's engine runs (Bonsai 2 9B). */
const minMemHere = () => (prismAsset() && CATALOG.some(m => m.id === SMALL_LOCAL.id) ? 8 : MIN_MEM);

// The catalog in use: the one this version shipped with, or a newer one the
// practitioner fetched from harmonism.io (Library Languages and Updates…).
// Both arrays are changed in place, so every module holding them sees the change.
const CATALOG = [...BUNDLED];
// [minimum memory in GB, model id], largest first. A "32 GB" machine reports ~31.x,
// a "256 GB" Mac Studio ~255; below 16 GB the last entry is shown with a warning.
// One model per family, one per common memory size: small, medium, high, workstation.
const BUNDLED_DEFAULTS = [[240, "deepseek-v4-flash"], [46, "qwen35-35b-a3b"], [30, "gemma4-26b-heretic"], [0, "ministral-14b"]];
const DEFAULTS = BUNDLED_DEFAULTS.map(d => [...d]);

// The local model recommended where it runs, the one exception to "never a default":
// Bonsai 2 27B Heretic, on computers of 16 GB up to the
// class where a larger model fits (46 GB, Qwen 3.5 35B). Still shown as untested.
// A model on this computer is no longer the first-launch default: DeepSeek V4.1
// Flash, on the account or under the practitioner's key, is (launcher.html).
const PREFERRED_LOCAL = { id: "bonsai2-27b-heretic", from: 15, below: 46 };   // 15: a "16 GB" PC can report a little under 16
// Under 16 GB: the smaller Bonsai, where Prism ML's engine runs. 16 GB is the
// floor for holding the doctrine; 8 GB the floor for any useful answer (Tahir, 19 Oct).
const SMALL_LOCAL = { id: "bonsai2-9b", from: 7 };

/** The model recommended for a machine with `memGB` of RAM (unified memory on Apple silicon). */
function defaultFor(memGB) {
  if (process.env.MUNAI_TEST_MODEL === "tiny") return "tiny";
  const has = id => prismAsset() && CATALOG.some(m => m.id === id && !m.retired);
  if (memGB >= PREFERRED_LOCAL.from && memGB < PREFERRED_LOCAL.below && has(PREFERRED_LOCAL.id)) return PREFERRED_LOCAL.id;
  if (memGB < PREFERRED_LOCAL.from && has(SMALL_LOCAL.id)) return SMALL_LOCAL.id;
  for (const [min, id] of DEFAULTS) if (memGB >= min && CATALOG.some(m => m.id === id && !m.retired)) return id;
  return CATALOG.filter(m => !m.retired).pop()?.id;
}

// ─── The catalog as data ─────────────────────────────────────────────
// Published by harmonia-astro/post-build.sh as /lodestone-app/models/catalog.json
// (tools/export-catalog.js). Nothing in it runs: it names files on Hugging Face,
// their sizes and SHA-256, and the download checks every byte against them.

const HEX64 = /^[0-9a-f]{64}$/, REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const okFile = f => f && typeof f.path === "string" && f.path.endsWith(".gguf") && !f.path.includes("..") && Number.isSafeInteger(f.size) && f.size > 0 && HEX64.test(f.sha256);

/** A published catalog, checked field by field; throws on anything malformed. */
function validateCatalog(d) {
  if (!d || d.schema !== 1 || !Array.isArray(d.models) || !d.models.length) throw new Error("The model list is not in a form this Lodestone reads.");
  const models = d.models.map(m => {
    if (!ID.test(m.id) || m.id.startsWith("hf:") || typeof m.label !== "string" || !REPO.test(m.repo)) throw new Error(`The model list has a malformed entry (${m?.id}).`);
    if (!Array.isArray(m.files) || !m.files.length || !m.files.every(okFile)) throw new Error(`The model list names a file it cannot check (${m.id}).`);
    if (m.mmproj && !(REPO.test(m.mmproj.repo) && okFile(m.mmproj))) throw new Error(`The model list names a vision file it cannot check (${m.id}).`);
    if (!(Number.isFinite(m.minMem) && m.minMem > 0)) throw new Error(`The model list gives no memory for ${m.id}.`);
    const out = { id: m.id, label: m.label, repo: m.repo, files: m.files.map(f => ({ path: f.path, size: f.size, sha256: f.sha256 })), minMem: m.minMem,
      hand: String(m.hand || ""), why: String(m.why || "") };
    if (m.mmproj) out.mmproj = { repo: m.mmproj.repo, path: m.mmproj.path, size: m.mmproj.size, sha256: m.mmproj.sha256 };
    if (m.ugi && typeof m.ugi === "object") out.ugi = m.ugi;
    if (m.retired === true) out.retired = true;
    return out;
  });
  const ids = new Set(models.map(m => m.id));
  if (ids.size !== models.length) throw new Error("The model list names a model twice.");
  const defaults = (Array.isArray(d.defaults) ? d.defaults : []).filter(x => Array.isArray(x) && Number.isFinite(x[0]) && ids.has(x[1])).map(x => [x[0], x[1]]);
  const recommended = (Array.isArray(d.recommended) ? d.recommended : []).filter(r => r && typeof r.id === "string" && /^[A-Za-z0-9._:\/-]{3,120}$/.test(r.id)).map(r => ({
    id: r.id, label: String(r.label || r.id), maker: String(r.maker || ""), licence: String(r.licence || ""),
    reasoning: r.reasoning === "" ? "" : "none", minTokens: Number.isSafeInteger(r.minTokens) && r.minTokens >= 0 && r.minTokens <= 32000 ? r.minTokens : 0, note: String(r.note || ""),
  }));
  return { models, defaults, recommended };
}

/** The hash a published catalog carries: SHA-256 of its three parts, in this order. */
const catalogHash = ({ models, defaults, recommended }) =>
  require("crypto").createHash("sha256").update(JSON.stringify({ models, defaults, recommended })).digest("hex");

/**
 * Use a checked catalog. Models it no longer lists stay available when `keep`
 * says so (downloaded, or the one chosen), so an update never takes away a
 * model the practitioner has.
 */
function applyCatalog(data, keep = () => false) {
  const ids = new Set(data.models.map(m => m.id));
  // A model on a second engine belongs to the app version that knows that engine:
  // it is never published (bundledData), so a fetched list never removes it.
  const kept = BUNDLED.filter(m => !ids.has(m.id) && (m.engine || keep(m)));
  CATALOG.splice(0, CATALOG.length, ...data.models, ...kept);
  if (data.defaults.length) DEFAULTS.splice(0, DEFAULTS.length, ...data.defaults.sort((a, b) => b[0] - a[0]));
}

/** This version's own catalog, in the published shape (for the exporter and the comparison). */
function bundledData(recommended) {
  // Models on a second engine are left out: an older app reading the published
  // list would download them and fail to load them on its own engine.
  return { models: BUNDLED.filter(m => !m.engine).map(m => ({ ...m })), defaults: BUNDLED_DEFAULTS.map(d => [...d]), recommended };
}

const size = m => m.files.reduce((n, f) => n + f.size, 0);

/** The next smaller model, offered when one will not load on this computer. */
function smallerThan(m) {
  return CATALOG.filter(x => x.id !== "tiny" && !x.retired && !x.untested && size(x) < size(m)).sort((a, b) => size(b) - size(a))[0] || null;
}

/** The model's page on Hugging Face, where its files can also be downloaded by hand. */
const page = m => `https://huggingface.co/${m.repo}`;

const url = (repo, p) => `https://huggingface.co/${repo}/resolve/main/${p.split("/").map(encodeURIComponent).join("/")}`;

/**
 * A Hugging Face GGUF the practitioner names: a page or download link, or
 * "owner/repo/path/file.gguf". Returns a catalog-shaped entry with every shard
 * and its hash, read from the Hugging Face API; nothing is guessed.
 */
async function fromHuggingFace(input, fetch) {
  const s = String(input || "").trim()
    .replace(/^https?:\/\/(www\.)?(huggingface\.co|hf\.co)\//, "")
    .replace(/\?.*$/, "");
  const m = s.match(/^([^/]+\/[^/]+)\/(?:(?:blob|resolve)\/[^/]+\/)?(.+\.gguf)$/i);
  if (!m) throw new Error("Paste the link to a .gguf file on Hugging Face, for example https://huggingface.co/owner/repo/blob/main/model.Q4_K_M.gguf");
  const [, repo, file] = m;
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main${dir ? "/" + dir.split("/").map(encodeURIComponent).join("/") : ""}`);
  if (!res.ok) throw new Error(res.status === 404 ? "Hugging Face does not know that repository or folder." : `Hugging Face answered ${res.status}.`);
  const tree = await res.json();
  const shard = file.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
  const wanted = shard
    ? tree.filter(f => f.type === "file" && new RegExp(`^${shard[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{5}-of-${shard[3]}\\.gguf$`, "i").test(f.path))
    : tree.filter(f => f.type === "file" && f.path === file);
  if (!wanted.length) throw new Error("That file is not in the repository.");
  if (shard && wanted.length !== Number(shard[3])) throw new Error(`The model is split into ${Number(shard[3])} parts but only ${wanted.length} were found.`);
  if (wanted.some(f => !f.lfs?.oid)) throw new Error("Hugging Face publishes no checksum for this file, so it cannot be verified.");
  wanted.sort((a, b) => a.path.localeCompare(b.path));
  const name = (shard ? shard[1] : file.replace(/\.gguf$/i, "")).split("/").pop();
  return {
    id: "hf:" + repo + "/" + file, custom: true,
    label: name, repo,
    files: wanted.map(f => ({ path: f.path, size: f.size, sha256: f.lfs.oid })),
    minMem: Math.ceil(wanted.reduce((n, f) => n + f.size, 0) / 1e9 * 1.25 + 4),
    hand: repo.split("/")[0],
    why: `Your choice, from ${repo}. Lodestone has not assessed it.`,
  };
}

module.exports = { CATALOG, MIN_MEM, minMemHere, defaultFor, smallerThan, size, url, page, prismAsset, PRISM_ENGINE, fromHuggingFace, validateCatalog, catalogHash, applyCatalog, bundledData };
