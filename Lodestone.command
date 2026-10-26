#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Lodestone — double-click this file.
#
# It starts a model on this computer and opens Lodestone in your browser. The first
# run downloads a model (several gigabytes, once). After that it takes seconds.
#
# Nothing is sent anywhere. The model runs here, the articles are read from this
# folder, and your conversations stay in the browser on the device you use.
#
# To stop Lodestone, close this window or press Control-C.
#
# The installable app (Lodestone Desktop, from harmonism.io) does all of this
# without a Terminal window. This folder remains for anyone who prefers it.
# ─────────────────────────────────────────────────────────────────────────────

# Finder opens this with the home folder as the working directory, so the script
# has to move to its own folder first — without relying on dirname, which need
# not be on PATH when a .command is launched from Finder.
SELF="${BASH_SOURCE[0]}"
case "$SELF" in */*) cd "${SELF%/*}" || exit 1 ;; esac
FOLDER="$(pwd)"

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
plain() { printf '%s\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n' "$1"; }
blank() { printf '\n'; }

stop() {
  blank
  plain "Lodestone has stopped. You can close this window."
  blank
  # Keeps the window readable when it was opened by double-click.
  [ -t 0 ] && read -r -p "Press return to close. " _
  exit "${1:-0}"
}

clear 2>/dev/null
blank
bold "  Lodestone"
dim  "  $FOLDER"
blank

# ── 1. Python ────────────────────────────────────────────────────────────────
# macOS ships python3 with the Command Line Tools. Nothing else is needed:
# serve.py uses only the standard library.
if ! command -v python3 >/dev/null 2>&1; then
  bold "One thing is missing: Python."
  plain "A window will ask to install the Apple developer command line tools."
  plain "Accept it, wait for it to finish, then double-click Lodestone again."
  blank
  xcode-select --install 2>/dev/null
  stop 1
fi

# ── 2. The articles ──────────────────────────────────────────────────────────
if [ ! -f "app/corpus/corpus.json" ]; then
  bold "The articles are missing from this folder."
  plain "This copy of Lodestone is incomplete. Download it again from"
  plain "harmonism.io and unzip the whole folder before opening this file."
  stop 1
fi

# ── 3. Ollama ────────────────────────────────────────────────────────────────
# Ollama is what actually runs the model. It is a normal Mac application.
OLLAMA=""
for candidate in "$(command -v ollama 2>/dev/null)" \
                 "/usr/local/bin/ollama" \
                 "/opt/homebrew/bin/ollama" \
                 "/Applications/Ollama.app/Contents/Resources/ollama" \
                 "$HOME/Applications/Ollama.app/Contents/Resources/ollama"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then OLLAMA="$candidate"; break; fi
done

if [ -z "$OLLAMA" ]; then
  bold "One thing is missing: Ollama."
  plain "Ollama is the free program that runs the model on this computer."
  blank
  plain "The download page is opening now. Install it the ordinary way —"
  plain "open the downloaded file and drag Ollama into Applications — then"
  plain "double-click Lodestone again."
  blank
  open "https://ollama.com/download" 2>/dev/null
  stop 1
fi

# Is it running? Starting the app is enough; it listens on 11434.
if ! curl -fsS --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  plain "Starting Ollama…"
  open -a Ollama 2>/dev/null || ("$OLLAMA" serve >/dev/null 2>&1 &)
  for ((i = 0; i < 30; i++)); do
    curl -fsS --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -fsS --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
    bold "Ollama would not start."
    plain "Open Ollama from your Applications folder, then double-click"
    plain "Lodestone again."
    stop 1
  fi
fi

# ── 4. The model ─────────────────────────────────────────────────────────────
# Chosen by this computer's memory, the same choice Lodestone Desktop makes: only
# models that hold the whole doctrinal backbone with the conversation beside it,
# in Lodestone's own mode (thinking off, a 32,000-token window). Under 16 GB of
# memory no such model fits, and this folder does not offer a smaller one: a
# confident wrong answer in Lodestone's voice is worse than no answer at all.
#
# model.txt overrides the choice: put any name Ollama can pull in it.
Q35B="hf.co/unsloth/Qwen3.5-35B-A3B-GGUF:Q4_K_M"
G4="hf.co/mradermacher/gemma-4-26B-A4B-it-uncensored-heretic-GGUF:Q4_K_M"
M14="hf.co/mistralai/Ministral-3-14B-Instruct-2512-GGUF:Q4_K_M"

MEM_GB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 8589934592) / 1073741824 ))
if   [ "$MEM_GB" -ge 46 ]; then AUTO="$Q35B"; ABOUT="Qwen 3.5 35B · 22 GB"
elif [ "$MEM_GB" -ge 30 ]; then AUTO="$G4";   ABOUT="Gemma 4 26B, uncensored · 17 GB"
elif [ "$MEM_GB" -ge 15 ]; then AUTO="$M14";  ABOUT="Ministral 3 14B · 8 GB"
else                            AUTO=""
fi

MODEL=""
[ -f "model.txt" ] && MODEL="$(tr -d ' \t\r\n' < model.txt)"
case "$MODEL" in
  # The previous launcher wrote its own pick here. Those were vendor weights
  # that refuse on contested ground; they are replaced unless chosen again.
  ""|qwen3:32b|qwen3:14b|qwen3:8b|*gemma-3-12b*|*Qwen3.5-9B*|*gemma-4-26B*:Q8_0)
    [ -n "$MODEL" ] && dim "  Replacing the earlier default ($MODEL) with a model that holds Lodestone's doctrine."
    MODEL="$AUTO"
    [ -n "$MODEL" ] && printf '%s\n' "$MODEL" > model.txt ;;
  *) ABOUT="$MODEL (from model.txt)" ;;
esac

if [ -z "$MODEL" ]; then
  blank
  bold "This computer has ${MEM_GB} GB of memory, and Lodestone needs 16 GB to think on it."
  plain "No model small enough to fit here holds Lodestone's doctrine. Open"
  plain "https://harmonism.io/lodestone-app/ instead: it keeps your memory on this"
  plain "computer and thinks through a free harmonism.io account or your own"
  plain "OpenRouter key. To try a model of your own choosing anyway, put its name"
  plain "in model.txt and double-click Lodestone again."
  open "https://harmonism.io/lodestone-app/" 2>/dev/null
  stop 1
fi

INSTALLED="$("$OLLAMA" list 2>/dev/null | awk 'NR>1 {print tolower($1)}')"
LOWER="$(printf '%s' "$MODEL" | tr '[:upper:]' '[:lower:]')"
if ! printf '%s\n' "$INSTALLED" | grep -qxF -e "$LOWER" -e "$LOWER:latest"; then
  blank
  bold "Downloading the model — $ABOUT"
  plain "This happens once. Leave this window open; it can take a while."
  blank
  if ! "$OLLAMA" pull "$MODEL"; then
    blank
    bold "The model could not be downloaded."
    plain "Check the internet connection and double-click Lodestone again."
    plain "If Ollama says it does not know this kind of model, update Ollama"
    plain "from ollama.com. To use a different model, put its name in model.txt."
    stop 1
  fi
fi

# ── 5. Serve it ──────────────────────────────────────────────────────────────
PORT="$(python3 - <<'PY'
import socket
for p in range(8765, 8790):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); print(p); break
    except OSError:
        continue
    finally:
        s.close()
else:
    print(8765)
PY
)"

blank
bold "Lodestone is starting — $ABOUT"
plain "Your browser will open in a moment. To use Lodestone on your phone, look for"
plain "the second address below and type it into the phone's browser — the phone"
plain "and this computer must be on the same Wi-Fi."
blank

# The browser opens only once the server is actually answering.
( for ((i = 0; i < 600; i++)); do
    curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 && { open "http://localhost:${PORT}/"; exit; }
    sleep 1
  done ) &
OPENER=$!

python3 tools/serve.py --port "$PORT" --lan --model "$MODEL" --check
STATUS=$?
kill "$OPENER" 2>/dev/null
if [ "$STATUS" -eq 3 ]; then
  blank
  bold "This model does not work with the Ollama on this computer."
  plain "Updating Ollama from ollama.com fixes this in most cases. Otherwise,"
  plain "put another model's name in model.txt (the models Lodestone Desktop offers"
  plain "are listed at harmonism.io/lodestone-desktop)"
  plain "and double-click Lodestone again."
  open "https://ollama.com/download" 2>/dev/null
  stop 1
fi
stop "$STATUS"
