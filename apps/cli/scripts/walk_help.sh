#!/usr/bin/env bash
# Walks every command in the manifold CLI tree, running `<path> --help` on
# each, and asserts exit code 0. Also runs `manifold help exit-codes` and
# `manifold completion <shell>` for each supported shell.
#
# Usage: scripts/walk_help.sh [path-to-binary]
set -o pipefail
# Note: deliberately not `set -u` — bash 3.2 (macOS's default /bin/bash)
# treats "${arr[@]}" on an empty array as an unbound-variable error even
# with a default expansion, and this script relies on an empty root path.

BIN="${1:-./bin/manifold}"
FAILURES=0
TOTAL=0

check() {
	local desc="$1"
	shift
	TOTAL=$((TOTAL + 1))
	if ! "$BIN" "$@" >/tmp/walk_help.out 2>&1; then
		FAILURES=$((FAILURES + 1))
		echo "FAIL ($?): $desc"
		sed 's/^/    /' /tmp/walk_help.out
	else
		echo "ok:   $desc"
	fi
}

# Recursively discover the command tree from `--help` output. Cobra lists
# subcommands under "Available Commands:" until a blank line.
walk() {
	local -a path=("$@")
	local help_out
	help_out="$("$BIN" "${path[@]}" --help 2>&1)"
	check "${path[*]:-<root>} --help" "${path[@]}" --help

	local in_commands=0
	while IFS= read -r line; do
		if [[ "$line" == "Available Commands:" ]]; then
			in_commands=1
			continue
		fi
		if [[ $in_commands -eq 1 ]]; then
			if [[ -z "$line" ]]; then
				in_commands=0
				continue
			fi
			# First whitespace-delimited token is the subcommand name.
			local name
			name="$(awk '{print $1}' <<<"$line")"
			case "$name" in
			help | completion) continue ;; # cobra builtins, not part of the domain tree
			esac
			if [[ -n "$name" ]]; then
				walk "${path[@]}" "$name"
			fi
		fi
	done <<<"$help_out"
}

walk

echo
echo "--- extra topics ---"
check "help exit-codes" help exit-codes
for sh in bash zsh fish powershell; do
	check "completion $sh" completion "$sh"
done

echo
echo "Checked $TOTAL invocations, $FAILURES failed."
if [[ $FAILURES -gt 0 ]]; then
	exit 1
fi
exit 0
