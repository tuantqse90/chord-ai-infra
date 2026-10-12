#!/usr/bin/env bash
# Install the chord-trust agent skill (Chord's trust layer for AI agents on Monad).
#
# Copies the skill folder to:
#   ~/.claude/skills/chord-trust   (Claude Code, personal skills)
#   ~/.agents/skills/chord-trust   (agents that read the shared ~/.agents/skills folder, e.g. Codex)
# and prints the OpenClaw and Hermes paths with the command to copy it there.
#
# Usage:
#   bash scripts/install.sh                      # from a copy of the skill folder: both personal folders
#   curl -fsSL https://chordsi.xyz/skills/chord-trust/scripts/install.sh | bash
#                                                # no copy yet: downloads the files from chordsi.xyz first
#   bash scripts/install.sh --only claude        # just ~/.claude/skills/chord-trust  (or: --only agents)
#   bash scripts/install.sh --project DIR        # DIR/.claude/skills/chord-trust only (project-scoped)
#   bash scripts/install.sh --from-url [BASE]    # download from BASE (default https://chordsi.xyz/skills/chord-trust)
#   bash scripts/install.sh --dry-run            # print what would happen, change nothing
#   bash scripts/install.sh --uninstall          # remove the copies this script manages
#
# Safe to run again: each target is replaced as a whole, and only when it is empty or already holds
# this skill (SKILL.md with "name: chord-trust"). Network is used only in download mode.
set -euo pipefail

SKILL_NAME="chord-trust"
BASE_DEFAULT="https://chordsi.xyz/skills/chord-trust"
FILES="SKILL.md README.md references/verify.md references/trustgate.md references/keep-a-record.md references/api.md references/safety.md references/examples.md scripts/trust.py scripts/record.mjs scripts/install.sh"
ONLY=""
PROJECT=""
FROM_URL=""
DRY_RUN=0
UNINSTALL=0

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) ONLY="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --from-url) if [[ -n "${2:-}" && "${2:-}" != --* ]]; then FROM_URL="$2"; shift 2; else FROM_URL="$BASE_DEFAULT"; shift; fi ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null || true; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

case "$ONLY" in ""|claude|agents) ;; *) die "--only takes 'claude' or 'agents'" ;; esac

# ---- where the skill comes from --------------------------------------------------------------
TMP_DIR=""
cleanup() { [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]] && rm -rf "$TMP_DIR"; return 0; }
trap cleanup EXIT

SRC=""
SELF="${BASH_SOURCE[0]:-}"
if [[ -z "$FROM_URL" && -n "$SELF" && -f "$SELF" ]]; then
  CAND="$(cd "$(dirname "$SELF")/.." && pwd)"
  [[ -f "$CAND/SKILL.md" ]] && SRC="$CAND"
fi
if [[ -z "$SRC" && "$UNINSTALL" -eq 0 ]]; then
  # piped from curl, or --from-url: fetch the files
  BASE="${FROM_URL:-$BASE_DEFAULT}"
  [[ "$BASE" == https://* ]] || die "--from-url takes an https URL"
  command -v curl >/dev/null 2>&1 || die "curl is not installed"
  TMP_DIR="$(mktemp -d)"
  SRC="$TMP_DIR/$SKILL_NAME"
  printf 'Downloading %s ...\n' "$BASE"
  for f in $FILES; do
    mkdir -p "$SRC/$(dirname "$f")"
    curl -fsSL --max-time 60 "$BASE/$f" -o "$SRC/$f" || die "could not download $BASE/$f"
  done
fi

if [[ "$UNINSTALL" -eq 0 ]]; then
  [[ -f "$SRC/SKILL.md" ]] || die "no SKILL.md in $SRC"
  grep -q "^name: ${SKILL_NAME}\$" "$SRC/SKILL.md" || die "$SRC/SKILL.md is not the ${SKILL_NAME} skill"
fi

# ---- targets ---------------------------------------------------------------------------------
TARGETS=()
if [[ -n "$PROJECT" ]]; then
  [[ -d "$PROJECT" ]] || die "project folder $PROJECT does not exist"
  TARGETS+=("$(cd "$PROJECT" && pwd)/.claude/skills/${SKILL_NAME}")
else
  [[ -z "$ONLY" || "$ONLY" == "claude" ]] && TARGETS+=("$HOME/.claude/skills/${SKILL_NAME}")
  [[ -z "$ONLY" || "$ONLY" == "agents" ]] && TARGETS+=("$HOME/.agents/skills/${SKILL_NAME}")
fi

owned_or_empty() {
  # true when the folder does not exist, is empty, or already holds this skill
  local dir="$1"
  [[ ! -e "$dir" ]] && return 0
  [[ -d "$dir" ]] || return 1
  [[ -z "$(ls -A "$dir")" ]] && return 0
  [[ -f "$dir/SKILL.md" ]] && grep -q "^name: ${SKILL_NAME}\$" "$dir/SKILL.md"
}

for dest in "${TARGETS[@]}"; do
  if [[ -n "$SRC" && -d "$dest" && "$(cd "$SRC" && pwd -P)" == "$(cd "$dest" && pwd -P)" ]]; then
    printf 'skip    %s (this is the source folder)\n' "$dest"
    continue
  fi
  owned_or_empty "$dest" || die "$dest exists and is not the ${SKILL_NAME} skill; move it away first"
  if [[ "$UNINSTALL" -eq 1 ]]; then
    if [[ -e "$dest" ]]; then
      if [[ "$DRY_RUN" -eq 1 ]]; then printf 'would remove %s\n' "$dest"; else rm -rf "$dest"; printf 'removed %s\n' "$dest"; fi
    else
      printf 'absent  %s\n' "$dest"
    fi
    continue
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'would install %s -> %s\n' "$SRC" "$dest"
    continue
  fi
  mkdir -p "$(dirname "$dest")"
  staging="${dest}.installing.$$"
  rm -rf "$staging"
  cp -R "$SRC" "$staging"
  # never ship editor or OS litter
  find "$staging" \( -name '.DS_Store' -o -name '__pycache__' -o -name '*.pyc' \) -prune -exec rm -rf {} + 2>/dev/null || true
  chmod +x "$staging/scripts/"*.sh "$staging/scripts/"*.py 2>/dev/null || true
  rm -rf "$dest"
  mv "$staging" "$dest"
  printf 'installed %s\n' "$dest"
done

if [[ "$UNINSTALL" -eq 0 ]]; then
  cat <<EOT

Other agents (not changed by this script):
  OpenClaw : copy the installed folder to ~/.openclaw/skills/${SKILL_NAME}
             (or <your OpenClaw workspace>/skills/${SKILL_NAME} for one workspace)
  Hermes   : copy it to ~/.hermes/skills/${SKILL_NAME}

No key is needed to read. Check:  python3 <skill folder>/scripts/trust.py verify 10333
To keep your own agent's record:  export AGENT_KEY=0x...   (in your own shell; see references/keep-a-record.md)
The same checks as MCP tools:     claude mcp add --transport http chord-trust https://chordsi.xyz/mcp
EOT
fi
