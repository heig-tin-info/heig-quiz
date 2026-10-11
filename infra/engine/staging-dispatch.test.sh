#!/usr/bin/env bash
# Tests of the frozen staging dispatcher (staging-dispatch.sh, audit H4):
# its request grammar, what it runs for a valid request, and that it never
# reaches a checkout. No root, no Podman, no network: podman, systemctl,
# curl, journalctl, sleep and git are stubs that log their argv. Run by the
# CI's `checks` job, or by hand:
#   bash infra/engine/staging-dispatch.test.sh
# No `set -e`: every assertion runs and is counted.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/staging-dispatch.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
# expect <name> <command…>: one assertion, the command's status.
expect() {
	local name="$1"
	shift
	if "$@"; then
		printf 'ok    %s\n' "$name"
	else
		printf 'FAIL  %s\n' "$name" >&2
		failures=$((failures + 1))
	fi
}
not() { ! "$@"; }

t_sha=0123456789abcdef0123456789abcdef01234567
t_old=89abcdef0123456789abcdef0123456789abcdef
t_digest="sha256:$(printf 'a%.0s' $(seq 1 64))"
t_token=ghs_Tok3nValue_for_tests
t_id=1111111111111111111111111111111111111111111111111111111111111111
repo=ghcr.io/heig-tin-info/quiz-codespace
pd="podman --remote --url unix:///run/podman/podman.sock"

# --- 1. Static: the code (comments aside) names no checkout and runs nothing
# from one. A deploy that reached the tree would need one of these words.
code="$(grep -vE '^[[:space:]]*#' "$script")"
for pattern in '\bgit\b' '/opt/' 'install\.sh' 'lib\.sh' 'deploy\.sh' '\bsource\b' \
	'(^|[;&|[:space:]])\.[[:space:]]' '\beval\b' 'infra/' 'apps/' 'QUIZ_DEPLOY' \
	'\bcd\b' 'dirname' 'readlink' 'daemon-reload' '\binstall\b' '\bcp\b' '\bsed\b' '\btee\b'; do
	expect "static: no /$pattern/ in the code" not grep -qE "$pattern" <<<"$code"
done
one_exec_the_lock() {
	# shellcheck disable=SC2016  # the literal text of the script
	[ "$(grep -cE '\bexec\b' <<<"$code")" = 1 ] && grep -qF 'exec 9>"$LOCK"' <<<"$code"
}
expect "static: one exec, the lock's descriptor" one_exec_the_lock
# It writes no file but the lock: every redirection goes to /dev/null or to
# a standard stream, or is the lock's descriptor.
only_safe_redirections() {
	# shellcheck disable=SC2016  # the literal text of the script
	not grep -vxE '[[:space:]]*[0-9]?>(/dev/null|&[12]|"\$LOCK")' \
		< <(grep -oE '(^|[[:space:]])[0-9]?>{1,2}[[:space:]]*[^[:space:];]+' <<<"$code")
}
expect "static: no redirection into a file but the lock" only_safe_redirections
expect "static: a fixed PATH of root-owned directories" \
	grep -qx 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' <<<"$code"
expect "static: bash -n" bash -n "$script"

# --- 2. The stubs. Each logs "<name> <argv>" to $work/log; podman logs what
# login reads on stdin to $work/stdin instead.
bin="$work/bin"
mkdir -p "$bin"
for name in systemctl journalctl sleep; do
	printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" %s "$*" >> "%s/log"\n' "$name" "$work" > "$bin/$name"
done
cat > "$bin/git" <<EOF
#!/usr/bin/env bash
printf 'git %s\n' "\$*" >> "$work/log"
exit 99
EOF
cat > "$bin/curl" <<EOF
#!/usr/bin/env bash
printf 'curl %s\n' "\$*" >> "$work/log"
[ ! -e "$work/unhealthy" ]
EOF
cat > "$bin/podman" <<EOF
#!/usr/bin/env bash
printf 'podman %s\n' "\$*" >> "$work/log"
case " \$* " in
	*" login "*) cat >> "$work/stdin" ;;
	*" pull "*) echo $t_id ;;
	*" images "*) printf '%s\n' $t_sha $t_old staging prod latest $t_old ;;
esac
EOF
chmod +x "$bin"/*

# A booby-trapped checkout as the working directory: if anything of the
# tree ran, the marker would appear.
fake="$work/checkout"
mkdir -p "$fake/infra/engine" "$fake/apps/codespace/deploy"
for f in infra/engine/lib.sh infra/engine/deploy.sh apps/codespace/deploy/lib.sh apps/codespace/deploy/install.sh; do
	printf '#!/usr/bin/env bash\ntouch "%s/ran-from-tree"\n' "$work" > "$fake/$f"
	chmod +x "$fake/$f"
done

# The instance as the operator installed it.
touch "$work/quadlet" "$work/env"

# run <request>: the dispatcher's main, sourced, with its fixed paths moved
# under $work; sets rc. Every run starts from an empty log.
run() {
	: > "$work/log"
	: > "$work/stdin"
	rc=0
	(
		cd "$fake" || exit 99
		# shellcheck source=staging-dispatch.sh
		. "$script"
		# The stubs first, for this run only (the script fixes its PATH).
		# shellcheck disable=SC2030
		PATH="$bin:$PATH"
		QUADLET="$work/quadlet" ENV_FILE="$work/env" LOCK="$work/lock"
		SSH_ORIGINAL_COMMAND="$1" main
	) > "$work/out" 2> "$work/err" || rc=$?
}

# Predicates on the last run.
rc_is() { [ "$rc" = "$1" ]; }
log_empty() { [ ! -s "$work/log" ]; }
token_nowhere() { not grep -qF "$t_token" "$work/log" "$work/out" "$work/err"; }
token_on_stdin() { [ "$(cat "$work/stdin")" = "$t_token" ]; }
nothing_from_tree() { [ ! -e "$work/ran-from-tree" ]; }
no_git() { not grep -q '^git' "$work/log"; }

# --- 3. A valid request.
run "codespace staging $t_sha $t_digest $t_token"
expect "valid: exits 0" rc_is 0
expected="$pd login ghcr.io -u heig-tin-info --password-stdin
$pd pull -q $repo@$t_digest
$pd tag $t_id $repo:$t_sha
$pd tag $repo:$t_sha $repo:staging
systemctl restart quiz-codespace-net@staging.service
systemctl restart quiz-codespace-staging.service
curl -fsS -m 2 http://127.0.0.1:3120/healthz
$pd images --format {{.Tag}} --filter reference=$repo
$pd rmi $repo:$t_old"
expect "valid: exactly login, pull by digest, tags, restarts, health, untag" \
	diff <(printf '%s\n' "$expected") "$work/log"
expect "valid: the token reaches podman on stdin" token_on_stdin
expect "valid: the token is on no argv and in no output" token_nowhere
expect "valid: nothing ran from the tree" nothing_from_tree
expect "valid: git never ran" no_git

run "codespace   staging	$t_sha  $t_digest $t_token"
expect "valid: any run of blanks between the words" rc_is 0

# --- 4. Refused requests: exit 2, before any engine or systemd call, and
# the token in no output.
refused_cleanly() { rc_is 2 && log_empty && token_nowhere; }
refused() {
	run "$2"
	expect "refused: $1" refused_cleanly
}
refused "empty" ""
refused "no digest (the pre-digest form)" "codespace staging $t_sha $t_token"
refused "force" "force codespace staging $t_sha $t_digest $t_token"
refused "the prod instance" "codespace prod $t_sha $t_digest $t_token"
refused "the runner" "runner prod $t_sha $t_digest $t_token"
refused "the runner's bare form" "$t_sha $t_digest $t_token"
refused "an unknown instance" "codespace preview $t_sha $t_digest $t_token"
refused "an uppercase sha" "codespace staging ${t_sha^^} $t_digest $t_token"
refused "a short sha" "codespace staging ${t_sha:0:39} $t_digest $t_token"
refused "a branch name for the sha" "codespace staging main $t_digest $t_token"
refused "another digest algorithm" "codespace staging $t_sha sha512:${t_digest#sha256:} $t_token"
refused "a 63-hex digest" "codespace staging $t_sha ${t_digest:0:70} $t_token"
refused "a digest with a tag" "codespace staging $t_sha latest@$t_digest $t_token"
refused "a token with a shell metacharacter" "codespace staging $t_sha $t_digest tok;id"
refused "a token with a substitution" "codespace staging $t_sha $t_digest \$(id)"
refused "a token with a slash" "codespace staging $t_sha $t_digest ../../x"
refused "a trailing word" "codespace staging $t_sha $t_digest $t_token extra"
refused "a leading blank" " codespace staging $t_sha $t_digest $t_token"
refused "a second line" "codespace staging $t_sha $t_digest $t_token
codespace staging $t_sha $t_digest $t_token"
refused "a command appended" "codespace staging $t_sha $t_digest $t_token; rm -rf /"

# --- 5. An instance not installed: exit 2, nothing pulled.
rm "$work/quadlet"
run "codespace staging $t_sha $t_digest $t_token"
expect "no quadlet: exits 2, no engine call" refused_cleanly
touch "$work/quadlet"

# --- 6. A portal that never answers: exit 1, its journal shown, no untag.
touch "$work/unhealthy"
run "codespace staging $t_sha $t_digest $t_token"
expect "unhealthy: exits 1" rc_is 1
probes_then_journal() {
	[ "$(grep -c '^curl' "$work/log")" = 60 ] \
		&& grep -q '^journalctl -u quiz-codespace-staging.service' "$work/log"
}
expect "unhealthy: 60 probes, then the journal" probes_then_journal
expect "unhealthy: no untag" not grep -q ' rmi ' "$work/log"
rm "$work/unhealthy"

# --- 7. Executed (not sourced), a bad request is refused before the lock:
# no root needed, nothing written under /run.
rc=0
SSH_ORIGINAL_COMMAND="codespace staging nope" bash "$script" 2> "$work/err" || rc=$?
expect "executed: a bad request exits 2" rc_is 2
expect "executed: and says why" grep -q 'malformed request' "$work/err"

if [ "$failures" -gt 0 ]; then
	printf '\n%d failure(s)\n' "$failures" >&2
	exit 1
fi
printf '\nall passed\n'
