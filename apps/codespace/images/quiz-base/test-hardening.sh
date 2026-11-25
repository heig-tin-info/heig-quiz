#!/usr/bin/env bash
# The session's hardening, seen from inside the image (milestone-0 P1,
# M6-05; README § Testing): the start time, ASLR under the seccomp profile,
# the read-only root and the capabilities, the user namespace, the pids
# limit against a fork bomb, the seccomp profile's refusals. The flags are
# run-hardened.sh's, which the portal's engine copies (portal invariant 3);
# this tests that the image works under them.
# Exits non-zero on the first failure, with a clear message.
#
#   ./images/quiz-base/test-hardening.sh [<image>]    # or IMAGE=
#
# Prerequisites and APPARMOR=: test-lib.sh.
SUITE=hardening
# shellcheck source=test-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/test-lib.sh"
CTR_B="qb-${SUITE}-b"
CTR_BOMB="qb-${SUITE}-bomb"
SECCOMP_DEFAULT="${SECCOMP_DEFAULT:-/usr/share/containers/seccomp.json}"

cat > "${VOL_BASE}/a/work/hello.c" <<'EOF'
#include <stdio.h>
int main(void) {
  printf("&main=%p\n", (void *)main);
  return 0;
}
EOF

# § 5: the raw syscalls, so that the answer is the seccomp filter's (ENOSYS)
# and not a refusal by util-linux or AppArmor before the call.
cat > "${VOL_BASE}/a/work/nsprobe.c" <<'EOF'
#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <sys/mount.h>
int main(void) {
  int u = unshare(CLONE_NEWUSER) == 0 ? 0 : errno;
  int m = mount("none", "/tmp", "tmpfs", 0, NULL) == 0 ? 0 : errno;
  printf("unshare=%d mount=%d ENOSYS=%d\n", u, m, ENOSYS);
  return 0;
}
EOF

echo "seccomp : ${REPO_ROOT}/infra/seccomp/codespace.json"

# --------------------------------------------------------------------------
head2 "0. start under run-hardened.sh, and time to /healthz"
# --------------------------------------------------------------------------
T0=$(date +%s.%N)
start "$CTR_A" a
wait_healthz "$CTR_A"
T1=$(date +%s.%N)
BOOT=$(python3 -c "print(round(${T1}-${T0}, 2))")
ok "podman run -> /healthz 200 in ${BOOT} s: ${HEALTH}"
echo "MESURE_DEMARRAGE_SECONDES=${BOOT}"

# --------------------------------------------------------------------------
head2 "1. ASLR can be disabled: personality(ADDR_NO_RANDOMIZE) passes the seccomp profile"
# --------------------------------------------------------------------------
cexec 'cd /work && gcc -g -O0 -o a.out hello.c' >/dev/null 2>&1 || fail "gcc -g -O0 hello.c failed"
OUT=$(cexec 'gdb -batch -ex "show disable-randomization"' 2>&1)
case "$OUT" in
  *"is on."*) ok "gdb -batch -ex 'show disable-randomization' answers on" ;;
  *) fail "disable-randomization is not on" "$OUT" ;;
esac

A1=$(cexec 'cd /work && gdb -batch -ex run ./a.out 2>/dev/null | sed -n "s/^&main=//p"')
A2=$(cexec 'cd /work && gdb -batch -ex run ./a.out 2>/dev/null | sed -n "s/^&main=//p"')
[ -n "$A1" ] || fail "first run under gdb: address of main not read"
[ "$A1" = "$A2" ] || fail "the address of main changes between two runs under gdb ($A1 vs $A2): ADDR_NO_RANDOMIZE refused by the seccomp profile"
ok "two runs under gdb give the same address of main ($A1)"

# Control: with the default containers-common profile, the address must vary.
# That is what proves the one entry added to the profile is what acts. The
# control only swaps the seccomp profile: it keeps the AppArmor profile of the
# real run (under containers-default gdb cannot ptrace at all, and an empty gdb
# output would masquerade as a "stable address").
if [ -r "$SECCOMP_DEFAULT" ]; then
  ctrl_aa=()
  if [ -n "${APPARMOR-codespace}" ]; then ctrl_aa=(--security-opt "apparmor=${APPARMOR-codespace}"); fi
  CTRL_OUT=$(podman_remote run --rm --userns=auto --cap-drop=ALL \
      --security-opt no-new-privileges --security-opt "seccomp=${SECCOMP_DEFAULT}" "${ctrl_aa[@]}" \
      --read-only --tmpfs /tmp --tmpfs '/run:rw,nosuid,nodev,mode=1777' \
      --pids-limit 256 --memory 1536m --cpus 1 --network none \
      --entrypoint sh "$IMAGE" -c '
        cd /tmp
        cat > h.c <<"EOF"
#include <stdio.h>
int main(void) { printf("&main=%p\n", (void *)main); return 0; }
EOF
        gcc -g -O0 -o h h.c || exit 1
        for i in 1 2 3; do gdb -batch -ex run ./h 2>/dev/null | sed -n "s/^&main=//p"; done' 2>/dev/null)
  CTRL_RUNS=$(printf '%s\n' "$CTRL_OUT" | grep -c .)
  CTRL=$(printf '%s\n' "$CTRL_OUT" | grep . | sort -u | wc -l)
  if [ "$CTRL_RUNS" -lt 3 ]; then
    fail "invalid control: gdb printed $CTRL_RUNS address(es) out of 3 under the default profile (ptrace refused?), test 1 proves nothing"
  elif [ "$CTRL" -gt 1 ]; then
    ok "control: with the default profile the address varies ($CTRL values out of 3) — the personality(0x40000) addition is indeed the cause"
  else
    fail "invalid control: the default profile already gives a stable address, test 1 proves nothing"
  fi
else
  echo "  note default profile not found ($SECCOMP_DEFAULT), control not run"
fi

# --------------------------------------------------------------------------
head2 "2. read-only root, no capability"
# --------------------------------------------------------------------------
# /, /etc, code-server and its extensions are the contract check's (test.sh
# § 2); these are the toolchain's.
for p in /usr/bin/x /opt/baygon/x /opt/baygon/lib/python3.13/site-packages/baygon/__init__.py; do
  if cexec "touch $p" >/dev/null 2>&1; then fail "touch $p succeeded"; fi
done
ok "/usr/bin and /opt/baygon are read-only"

CAP=$(cexec 'grep CapEff /proc/self/status' | awk '{print $2}')
[ "$CAP" = "0000000000000000" ] || fail "CapEff is $CAP instead of 0000000000000000"
ok "CapEff = 0000000000000000"

NNP=$(cexec 'grep NoNewPrivs /proc/self/status' | awk '{print $2}')
[ "$NNP" = "1" ] || fail "NoNewPrivs is $NNP instead of 1"
ok "NoNewPrivs = 1"

SEC=$(cexec 'grep Seccomp: /proc/self/status' | awk '{print $2}')
[ "$SEC" = "2" ] || fail "Seccomp is $SEC instead of 2 (filter mode)"
ok "Seccomp = 2 (filter loaded)"

# The project AppArmor profile, not Podman's built-in containers-default-*:
# that one denies ptrace towards the stacked label `<profile>//&crun` and
# gdb would fail. The label is read from /proc/self/attr/apparmor/current, with
# the pre-5.1 path as a fallback; the value is `codespace (enforce)`, possibly
# with a `//&…` stack suffix.
if [ -z "${APPARMOR-codespace}" ]; then
  printf '  skip  AppArmor label (APPARMOR= : the flag was not passed)\n'
elif ! cexec 'test -r /proc/self/attr/apparmor/current || test -r /proc/self/attr/current' >/dev/null 2>&1; then
  printf '  skip  AppArmor label (host without AppArmor: no /proc/self/attr/…/current)\n'
else
  LABEL=$(cexec 'cat /proc/self/attr/apparmor/current 2>/dev/null || cat /proc/self/attr/current' | tr -d '\0\r')
  case "$LABEL" in
    unconfined*|"")
      fail "the container is not confined by the codespace profile: [$LABEL]" \
           "expected 'codespace (enforce)'; check apparmor_parser -r /etc/apparmor.d/codespace" ;;
    codespace*) : ;;
    *) fail "AppArmor label is [$LABEL] instead of the codespace profile" ;;
  esac
  ok "AppArmor label: $LABEL"
fi

# --------------------------------------------------------------------------
head2 "3. user namespace: host UID outside 0-65535"
# --------------------------------------------------------------------------
# uid 1000 inside is the contract check's (test.sh § 2).
HUSER_A=$(podman_remote top "$CTR_A" huser | sed -n '2p' | tr -d '[:space:]')
case "$HUSER_A" in
  ''|*[!0-9]*) fail "podman top huser did not return a numeric UID: [$HUSER_A]" ;;
esac
[ "$HUSER_A" -gt 65535 ] || fail "host UID $HUSER_A is inside the 0-65535 range: --userns=auto did not take"
ok "host UID of container A = $HUSER_A (outside 0-65535)"

start "$CTR_B" b
for _ in $(seq 1 100); do
  HUSER_B=$(podman_remote top "$CTR_B" huser 2>/dev/null | sed -n '2p' | tr -d '[:space:]')
  [ -n "${HUSER_B:-}" ] && break
  sleep 0.2
done
case "${HUSER_B:-}" in
  ''|*[!0-9]*) fail "podman top huser (B) did not return a numeric UID: [${HUSER_B:-}]" ;;
esac
[ "$HUSER_B" -gt 65535 ] || fail "host UID of B ($HUSER_B) is inside the 0-65535 range"
[ "$HUSER_A" != "$HUSER_B" ] || fail "the two containers share the same host UID ($HUSER_A)"
ok "two containers side by side: distinct host UIDs ($HUSER_A and $HUSER_B)"

# --------------------------------------------------------------------------
head2 "4. fork bomb: contained by --pids-limit 256, host untouched"
# --------------------------------------------------------------------------
PIDS_MAX=$(cexec 'cat /sys/fs/cgroup/pids.max')
[ "$PIDS_MAX" = "256" ] || fail "pids.max is $PIDS_MAX instead of 256"
ok "cgroup pids.max = 256"

HOST_PROCS_BEFORE=$(ps -e --no-headers | wc -l)
start "$CTR_BOMB" bomb
BOMB_CG=$(podman_remote inspect "$CTR_BOMB" --format '{{.State.CgroupPath}}')
[ -r "/sys/fs/cgroup${BOMB_CG}/pids.current" ] || fail "bomb cgroup unreadable: /sys/fs/cgroup${BOMB_CG}"

podman_remote exec "$CTR_BOMB" bash -c ':(){ :|:& };:' >/dev/null 2>&1 &
BOMB_PID=$!
MAXSEEN=0
for _ in $(seq 1 40); do
  CUR=$(cat "/sys/fs/cgroup${BOMB_CG}/pids.current" 2>/dev/null || echo 0)
  [ "$CUR" -gt "$MAXSEEN" ] && MAXSEEN=$CUR
  sleep 0.25
done
HOST_OK_START=$(date +%s.%N)
ps -e --no-headers >/dev/null
HOST_PROCS_AFTER=$(ps -e --no-headers | wc -l)
HOST_OK_ELAPSED=$(python3 -c "print(round($(date +%s.%N)-${HOST_OK_START}, 2))")

kill "$BOMB_PID" >/dev/null 2>&1
podman_remote rm -f "$CTR_BOMB" >/dev/null 2>&1

[ "$MAXSEEN" -le 256 ] || fail "the bomb cgroup went past 256 processes ($MAXSEEN)"
[ "$MAXSEEN" -ge 200 ] || fail "the bomb did not reach the limit ($MAXSEEN processes): the test proves nothing"
ok "the bomb tops out at $MAXSEEN processes, never above 256"

# The bomb's processes are host processes (rootful Podman, one kernel), so the
# host count legitimately rises by up to pids-limit. What must hold is that it
# never rises beyond that bound (nothing escapes the cgroup) and that the host
# keeps answering.
DELTA=$((HOST_PROCS_AFTER - HOST_PROCS_BEFORE))
[ "$DELTA" -le 300 ] || fail "the host process count jumped by $DELTA during the bomb: more than the 256 the cgroup allows"
ok "host: $HOST_PROCS_BEFORE -> $HOST_PROCS_AFTER processes (delta $DELTA, bounded by pids-limit), ps answers in ${HOST_OK_ELAPSED}s"

OUT=$(podman_remote exec "$CTR_A" curl -sS -m 3 -o /dev/null -w '%{http_code}' http://localhost:8080/healthz 2>&1)
[ "$OUT" = "200" ] || fail "container A no longer answers after the bomb (http $OUT)"
ok "neighbour container A still answers on /healthz after the bomb"

# --------------------------------------------------------------------------
head2 "5. seccomp: the runner's profile plus ptrace (M6-05)"
# --------------------------------------------------------------------------
# infra/seccomp/codespace.json is apps/runner/infra/seccomp/runner.json plus
# one rule allowing ptrace (src/seccomp.test.ts): no user namespace, no mount
# (gdb breaking and stepping is test-toolchain.sh § 1).
OUT=$(cexec 'unshare -r true' 2>&1) && fail "unshare -r true succeeded inside the container" "$OUT"
case "$OUT" in
  *"Function not implemented"*) ok "unshare -r true fails: Function not implemented" ;;
  *) fail "unshare -r true failed, but not on the seccomp filter (ENOSYS expected)" "$OUT" ;;
esac

OUT=$(cexec 'cd /work && gcc -o nsprobe nsprobe.c && ./nsprobe' 2>&1) \
  || fail "the namespace probe did not build or run" "$OUT"
case "$OUT" in
  "unshare=38 mount=38 ENOSYS=38") ok "raw unshare(CLONE_NEWUSER) and mount(2) answer ENOSYS: $OUT" ;;
  *) fail "unshare(2) or mount(2) did not answer ENOSYS" "$OUT" ;;
esac

passed
printf 'MESURE_DEMARRAGE_SECONDES=%s\n' "$BOOT"
