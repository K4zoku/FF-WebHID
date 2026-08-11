#!/usr/bin/env bash
# prepare-commit-msg hook: prepends an area scope to the subject when the
# change touches exactly one known area and the subject has no scope yet.
#   chore: add logging        ->  chore(addon): add logging   (touches addon/)
set -e

MSG_FILE="${1:?}"

first=$(sed -n '1p' "$MSG_FILE")

# Leave messages that already carry a scope: type(scope): subject.
if printf '%s' "$first" | grep -qE '^[a-z]+\([^)]*\):'; then
  exit 0
fi

# Only conventional-format subjects get a scope.
if ! printf '%s' "$first" | grep -qE '^(feat|fix|perf|refactor|docs|ci|chore|style|test|build|revert):'; then
  exit 0
fi

declare -A AREAS=(
  [addon/_locales/]=l10n
  [addon/]=addon
  [crates/webhid-daemon/]=daemon
  [crates/webhid/]=webhid
  [crates/webhid-native-messaging/]=nm
  [crates/webhid-mock/]=mock
  [scripts/]=build
  [Makefile]=build
  [crowdin.yml]=l10n
  [.pre-commit-config.yaml]=build
  [package.json]=build
  [package-lock.json]=build
)

declare -A COUNTS
unmatched=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  matched=0
  # Longest prefix first so addon/_locales/ beats addon/.
  for prefix in $(printf '%s\n' "${!AREAS[@]}" | awk '{ print length, $0 }' | sort -k1,1nr | cut -d' ' -f2-); do
    case "$path" in
      "$prefix"*) COUNTS["${AREAS[$prefix]}"]=$((COUNTS["${AREAS[$prefix]}"] + 1)); matched=1; break ;;
    esac
  done
  [ "$matched" -eq 1 ] || unmatched=$((unmatched + 1))
done < <(git diff --cached --name-only)

# Only rewrite when a single area was touched and nothing fell through.
[ "$unmatched" -eq 0 ] || exit 0
area=""
for a in "${!COUNTS[@]}"; do
  [ -z "$area" ] || exit 0
  area="$a"
done
[ -n "$area" ] || exit 0

type=$(printf '%s' "$first" | sed 's/:.*//')
# Redundant scopes: docs(docs), test(test), ci(ci) add nothing.
[ "$area" != "$type" ] || exit 0

sed -i "1s/^[a-z]*:/$type($area):/" "$MSG_FILE"
