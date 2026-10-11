#!/usr/bin/env bash
# Tests of the frozen staging dispatcher (staging-dispatch.sh, audit H4):
# its request grammar, what it runs for a valid request, and that it agrees
# with the instance table of apps/codespace/deploy/lib.sh. No root, no
# Podman, no network. Each run gets a PATH of stubs (podman, systemctl,
# curl, journalctl, sleep, which log their argv) and of the few real tools
# it needs (flock, seq, grep, sort): any other external command fails, so
# the argv log is everything it ran. Run by the CI's `checks` job, or:
#   bash infra/engine/staging-dispatch.test.sh
# No `set -e`: every assertion runs and is counted.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
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

# --- 1. Static, for what a PATH cannot catch: builtins, and a program
# started by its path (comments aside).
code="$(grep -vE '^[[:space:]]*#' "$script")"
for pattern in '\beval\b' '\bsource\b' '(^|[;&|[:space:]])\.[[:space:]]' '/opt/' \
	'(^|[[:space:];&|(])\.{0,2}/'; do
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
expect "static: a fixed PATH" \
	grep -qx 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' <<<"$code"
expect "static: bash -n" bash -n "$script"

# --- 2. In step with what production writes: the instance's row of
# apps/codespace/deploy/lib.sh, the lock of infra/engine/deploy.sh.
in_step() {
	(
		# shellcheck source=../../apps/codespace/deploy/lib.sh
		. "$root/apps/codespace/deploy/lib.sh"
		cs_instance staging
		# shellcheck source=staging-dispatch.sh
		. "$script"
		[ "$REPO" = "$CS_IMAGE_REPO" ] \
			&& [ "$INSTANCE" = "$CS_INSTANCE" ] \
			&& [ "$UNIT" = "$CS_UNIT.service" ] \
			&& [ "$NET_UNIT" = "quiz-codespace-net@$CS_INSTANCE.service" ] \
			&& [ "$QUADLET" = "/etc/containers/systemd/$CS_UNIT.container" ] \
			&& [ "$ENV_FILE" = "$CS_ETC/env" ] \
			&& [ "$HEALTH_URL" = "http://127.0.0.1:$CS_PORT/healthz" ] \
			&& [ "$PODMAN_URL" = "$ENGINE_PODMAN_URL" ]
	)
}
expect "in step: the staging row of codespace's lib.sh" in_step
expect "in step: deploy.sh takes the same lock" \
	grep -qF 'exec 9>/run/quiz-engine-deploy.lock' "$here/deploy.sh"

# --- 3. The stubs and the allowed real tools.
bin="$work/bin"
mkdir -p "$bin"
bash_path="$(command -v bash)"
cat_path="$(command -v cat)"
for name in systemctl journalctl sleep; do
	printf '#!%s\nprintf "%%s %%s\\n" %s "$*" >> "%s/log"\n' "$bash_path" "$name" "$work" > "$bin/$name"
done
cat > "$bin/curl" <<EOF
#!$bash_path
printf 'curl %s\n' "\$*" >> "$work/log"
[ ! -e "$work/unhealthy" ]
EOF
cat > "$bin/podman" <<EOF
#!$bash_path
printf 'podman %s\n' "\$*" >> "$work/log"
case " \$* " in
	*" login "*) $cat_path >> "$work/stdin" ;;
	*" pull "*) [ ! -e "$work/pullfails" ] || exit 125; echo $t_id ;;
	*" images "*) printf '%s\n' $t_sha $t_old staging prod latest $t_old ;;
esac
EOF
chmod +x "$bin"/*
for tool in flock seq grep sort; do
	ln -s "$(command -v "$tool")" "$bin/$tool"
done

# The instance as the operator installed it.
touch "$work/quadlet" "$work/env"

# run <request>: the dispatcher's main, sourced, with its fixed paths moved
# under $work and its PATH replaced by $bin; sets rc. Each run starts from
# an empty log.
run() {
	: > "$work/log"
	: > "$work/stdin"
	# Not the left side of `||`: there, bash would ignore the script's -e.
	(
		# shellcheck source=staging-dispatch.sh
		. "$script"
		# shellcheck disable=SC2030  # for this run only
		PATH="$bin"
		QUADLET="$work/quadlet" ENV_FILE="$work/env" LOCK="$work/lock"
		SSH_ORIGINAL_COMMAND="$1" main
	) > "$work/out" 2> "$work/err"
	rc=$?
}

rc_is() { [ "$rc" = "$1" ]; }
log_empty() { [ ! -s "$work/log" ]; }
token_nowhere() { not grep -qF "$t_token" "$work/log" "$work/out" "$work/err"; }
token_on_stdin() { [ "$(cat "$work/stdin")" = "$t_token" ]; }

# --- 4. A valid request: exactly these commands, nothing else.
run "codespace staging $t_sha $t_digest $t_token"
expect "valid: exits 0" rc_is 0
expected="$pd login ghcr.io -u heig-tin-info --password-stdin
$pd pull -q $repo@$t_digest
$pd logout ghcr.io
$pd tag $t_id $repo:$t_sha
$pd tag $repo:$t_sha $repo:staging
systemctl restart quiz-codespace-net@staging.service
systemctl restart quiz-codespace-staging.service
curl -fsS -m 2 http://127.0.0.1:3120/healthz
$pd images --format {{.Tag}} --filter reference=$repo
$pd rmi $repo:$t_old"
expect "valid: login, pull by digest, logout, tags, restarts, health, untag" \
	diff <(printf '%s\n' "$expected") "$work/log"
expect "valid: the token reaches podman on stdin" token_on_stdin
expect "valid: the token is on no argv and in no output" token_nowhere

run "codespace   staging	$t_sha  $t_digest $t_token"
expect "valid: any run of blanks between the words" rc_is 0

# --- 5. Refused requests: exit 2, before any command, the token in no output.
refused_cleanly() { rc_is 2 && log_empty && token_nowhere; }
refused() {
	run "$2"
	expect "refused: $1" refused_cleanly
}
refused "empty" ""
refused "no digest" "codespace staging $t_sha $t_token"
refused "force" "force codespace staging $t_sha $t_digest $t_token"
refused "another instance" "codespace prod $t_sha $t_digest $t_token"
refused "the runner's bare form" "$t_sha $t_digest $t_token"
refused "an uppercase sha" "codespace staging ${t_sha^^} $t_digest $t_token"
refused "another digest algorithm" "codespace staging $t_sha sha512:${t_digest#sha256:} $t_token"
refused "a substitution as token" "codespace staging $t_sha $t_digest \$(id)"
refused "a trailing word" "codespace staging $t_sha $t_digest $t_token extra"
refused "a second line" "codespace staging $t_sha $t_digest $t_token
codespace staging $t_sha $t_digest $t_token"

# --- 6. An instance not installed: exit 2, nothing run.
rm "$work/quadlet"
run "codespace staging $t_sha $t_digest $t_token"
expect "no quadlet: exits 2, nothing run" refused_cleanly
touch "$work/quadlet"

# --- 7. A failed pull: the credential is dropped all the same.
touch "$work/pullfails"
run "codespace staging $t_sha $t_digest $t_token"
expect "failed pull: exits non-zero" not rc_is 0
expect "failed pull: logged out, nothing tagged" \
	diff <(printf '%s\n' "$pd login ghcr.io -u heig-tin-info --password-stdin" "$pd pull -q $repo@$t_digest" "$pd logout ghcr.io") "$work/log"
rm "$work/pullfails"

# --- 8. A portal that never answers: exit 1, its journal shown, no untag.
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

# --- 9. Executed (not sourced), a bad request is refused before the lock:
# no root needed, nothing written under /run.
SSH_ORIGINAL_COMMAND="codespace staging nope" bash "$script" 2> "$work/err"
rc=$?
expect "executed: a bad request exits 2" rc_is 2
expect "executed: and says why" grep -q 'malformed request' "$work/err"

if [ "$failures" -gt 0 ]; then
	printf '\n%d failure(s)\n' "$failures" >&2
	exit 1
fi
printf '\nall passed\n'
