#!/usr/bin/env bash
# What a C or C++ lab uses in the image (README § Testing): gdb under the
# session's hardening, the binaries, clangd's configuration and the manual
# pages, Baygon 0.7 (#1102), the debugger's own terminal (#1103), C++20 and
# its pretty-printers, pytest (2026-11-16). Not the contract: an image
# derived from quiz-base may change any of it.
# Exits non-zero on the first failure, with a clear message.
#
#   ./images/quiz-base/test-toolchain.sh [<image>]    # or IMAGE=
#
# Prerequisites and APPARMOR=: test-lib.sh.
SUITE=toolchain
# shellcheck source=test-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/test-lib.sh"

cat > "${VOL_BASE}/a/work/hello.c" <<'EOF'
#include <stdio.h>
static int square(int x) { return x * x; }
int main(void) {
  int a = 3;
  int b = square(a);
  printf("&main=%p\n", (void *)main);
  return b - 9;
}
EOF

# § 3: two Baygon test files, one passing and one failing, on /bin/cat.
cat > "${VOL_BASE}/a/work/baygon-ok.yaml" <<'EOF'
version: 1
executable: /bin/cat
tests:
  - name: Echoes its input
    stdin: "hello\n"
    stdout:
      - equals: "hello\n"
    exit: 0
EOF
sed 's/equals: "hello/equals: "bye/' "${VOL_BASE}/a/work/baygon-ok.yaml" > "${VOL_BASE}/a/work/baygon-ko.yaml"

# § 4: the student's program of #1103, and the debug session's driver. The
# breakpoint of test-debug-io.js is line 7.
cat > "${VOL_BASE}/a/work/io.c" <<'EOF'
#include <stdio.h>
int main(void) {
  int a = 0;
  printf("enter a=\n");
  if (scanf("%d", &a) != 1) return 2;
  int b = a * 2;
  printf("a*2=%d\n", b);
  return 0;
}
EOF
cp "${HERE}/test-debug-io.js" "${VOL_BASE}/a/work/test-debug-io.js"

# § 5: a C++20 program on the standard library (<vector>, <ranges>, <format>,
# all in GCC 14's libstdc++), and a C file for clangd's per-language flags.
# The breakpoint of § 5 is line 9, once `evens` is built.
cat > "${VOL_BASE}/a/work/cpp20.cpp" <<'EOF'
#include <format>
#include <iostream>
#include <ranges>
#include <vector>
int main() {
  std::vector<int> v{1, 2, 3, 4, 5, 6};
  auto even = v | std::views::filter([](int x) { return x % 2 == 0; });
  std::vector<int> evens(even.begin(), even.end());
  std::cout << std::format("evens={} first={}\n", evens.size(), evens.front());
  return 0;
}
EOF
# The C++ counterpart of io.c, for test-debug-io.js: same lines, same I/O,
# the breakpoint on line 7.
cat > "${VOL_BASE}/a/work/iocpp.cpp" <<'EOF'
#include <iostream>
int main() {
  int a = 0;
  std::cout << "enter a=" << std::endl;
  if (!(std::cin >> a)) return 2;
  int b = a * 2;
  std::cout << "a*2=" << b << std::endl;
  return 0;
}
EOF
cat > "${VOL_BASE}/a/work/clangd-c.c" <<'EOF'
#include <stdio.h>
int main(void) { printf("%ld\n", __STDC_VERSION__); return 0; }
EOF

# § 6: a pytest lab in miniature, as the C labs ship it: a Makefile whose
# `test` runs `pytest -vv --junitxml=report.xml`, a test that runs the
# compiled program through subprocess, and a conftest.py that imports
# `_pytest.junitxml.xml_key` (the labs' points script reads the report through
# it), checks the junitxml plugin really stored its key and leaves a marker;
# a second test checks that tmp_path is under /tmp (a tmpfs).
mkdir -p "${VOL_BASE}/a/work/pylab/tests"
cat > "${VOL_BASE}/a/work/pylab/add.c" <<'EOF'
#include <stdio.h>
int main(void) {
  int a, b;
  if (scanf("%d %d", &a, &b) != 2) return 2;
  printf("%d\n", a + b);
  return 0;
}
EOF
printf 'add: add.c\n\tgcc -Wall -o add add.c\ntest: add\n\tpytest -vv --junitxml=report.xml\n' \
  > "${VOL_BASE}/a/work/pylab/Makefile"
cat > "${VOL_BASE}/a/work/pylab/tests/conftest.py" <<'EOF'
from _pytest.junitxml import xml_key


def pytest_sessionstart(session):
    assert session.config.stash.get(xml_key, None) is not None
    (session.config.rootpath / "xml_key.ok").write_text("ok\n")
EOF
cat > "${VOL_BASE}/a/work/pylab/tests/test_x.py" <<'EOF'
import pathlib
import subprocess

EXE = pathlib.Path(__file__).resolve().parent.parent / "add"


def test_adds():
    out = subprocess.run([str(EXE)], input="2 3\n", capture_output=True, text=True, check=True)
    assert out.stdout == "5\n"


def test_tmp_path(tmp_path):
    assert str(tmp_path).startswith("/tmp/")
    (tmp_path / "f").write_text("x")
EOF

start "$CTR_A" a
wait_healthz "$CTR_A"
STATUSBAR_DIR=$(statusbar_dir)
[ -n "$STATUSBAR_DIR" ] || fail "no status-bar extension in /opt/code-server/extensions"

# --------------------------------------------------------------------------
head2 "1. gdb: ptrace allowed, no Operation not permitted"
# --------------------------------------------------------------------------
cexec 'cd /work && gcc -g -O0 -o a.out hello.c' >/dev/null 2>&1 || fail "gcc -g -O0 hello.c failed" "$(cexec 'cd /work && gcc -g -O0 -o a.out hello.c' 2>&1)"
# gdb exits 1 on "No stack." (the program is already finished when bt runs):
# it is the literal command from milestone-0, and we judge only its output.
OUT=$(cexec 'cd /work && gdb -batch -ex run -ex bt ./a.out' 2>&1)
case "$OUT" in
  *"Operation not permitted"*) fail "gdb ran into Operation not permitted" "$OUT" ;;
esac
case "$OUT" in
  *"&main=0x"*) : ;;
  *) fail "the program did not print the address of main under gdb" "$OUT" ;;
esac
ok "gcc -g -O0 hello.c then gdb -batch -ex run -ex bt: no Operation not permitted"

OUT=$(cexec 'cd /work && gdb -batch -ex "break main" -ex run -ex next -ex step -ex bt ./a.out' 2>&1) \
  || fail "gdb with a breakpoint failed" "$OUT"
case "$OUT" in
  *"Breakpoint 1, main ()"*"#0  square (x=3)"*"#1 "*"in main ()"*) : ;;
  *) fail "gdb did not break in main, then next and step into square" "$OUT" ;;
esac
ok "gdb breaks in main, steps over a line and into square (x=3), bt shows main below it"

# --------------------------------------------------------------------------
head2 "2. the binaries, clangd's configuration, the manual pages"
# --------------------------------------------------------------------------
cexec 'test -x /usr/bin/clangd && test -x /usr/bin/gdb && test -x /usr/bin/gcc && test -x /usr/bin/g++ && test -x /usr/bin/make && test -x /usr/bin/git && test -x /usr/bin/python3 && test -x /usr/local/bin/baygon && test -x /usr/bin/pytest' >/dev/null 2>&1 \
  || fail "one of the expected binaries is missing (clangd, gdb, gcc, g++, make, git, python3, baygon, pytest)"
ok "gcc, g++, gdb, make, git, clangd, python3, baygon, pytest present"

cexec 'cmp /etc/clangd/config.yaml /home/student/.config/clangd/config.yaml && cmp /etc/clangd/config.yaml /run/code-server/xdg-config/clangd/config.yaml' >/dev/null 2>&1 \
  || fail "the clangd configuration is not at both expected paths"
ok "clangd configuration present in ~/.config and in the server's XDG_CONFIG_HOME"

cexec 'man 2 ptrace 2>/dev/null | head -1 | grep -q .' >/dev/null 2>&1 \
  || fail "the development manual pages are not installed (man 2 ptrace)"
ok "development manual pages available (man 2 ptrace)"

# --------------------------------------------------------------------------
head2 "3. baygon: pinned, offline, read-only (#1102)"
# --------------------------------------------------------------------------
# The labs' `make test` runs `baygon -v -t t.yaml`. Installed at build time
# from baygon/requirements.txt (every package pinned by hash); the container
# has no network, so this run proves nothing is fetched at run time.
OUT=$(cexec 'baygon --version' 2>&1)
case "$OUT" in
  *"Baygon version 0.7.0"*) ok "baygon on PATH: $OUT" ;;
  *) fail "baygon --version is not 0.7.0" "$OUT" ;;
esac

OUT=$(cexec 'cd /work && baygon -v -t baygon-ok.yaml' 2>&1) \
  || fail "baygon failed on a passing test file" "$OUT"
case "$OUT" in
  *"PASSED"*"ok."*) ok "baygon -v -t on a passing test file: PASSED, offline" ;;
  *) fail "baygon did not pass a trivial test file" "$OUT" ;;
esac
# Baygon 0.7.0 exits 0 even when a test fails: its summary is what is judged.
OUT=$(cexec 'cd /work && baygon -t baygon-ko.yaml' 2>&1)
case "$OUT" in
  *"FAILED"*"1 failed"*) ok "baygon reports a failing test as FAILED" ;;
  *) fail "baygon did not report a failing test" "$OUT" ;;
esac

# Nothing to install with, nothing to write: no pip in the venv nor for
# /usr/bin/python3 (a lab's `make points` falls back on `python3 -m pip`), and its
# byte-code compiled at build time (Python cannot write it on the read-only
# root, and would compile every module again on every run).
cexec 'test ! -e /opt/baygon/bin/pip && ! /opt/baygon/bin/python -m pip --version && ! /usr/bin/python3 -m pip --version' >/dev/null 2>&1 \
  || fail "pip is present in /opt/baygon or for /usr/bin/python3"
cexec 'ls /opt/baygon/lib/python3.13/site-packages/baygon/__pycache__/*.pyc' >/dev/null 2>&1 \
  || fail "baygon's byte-code was not compiled at build time"
ok "no pip in /opt/baygon nor for /usr/bin/python3, byte-code compiled at build time"

# --------------------------------------------------------------------------
head2 "4. debugging: the program reads and writes its own terminal (#1103)"
# --------------------------------------------------------------------------
# webfreak.debug leaves the program on gdb's pipes: its output is
# block-buffered into gdb's stream, its stdin is gdb's command stream. The
# status-bar extension gives every gdb launch a terminal of its own
# (extension/debugIo.js). test-debug-io.js plays that terminal with
# node-pty, the module of code-server's pty host, and the debug session with
# webfreak.debug's real adapter: a breakpoint on line 7, then "7" typed.
cexec 'cd /work && gcc -g -O0 -o io io.c' >/dev/null 2>&1 || fail "gcc io.c failed"
DBG=$(cexec "cd /work && /usr/lib/code-server/lib/node test-debug-io.js ${STATUSBAR_DIR} /opt/code-server/extensions/webfreak.debug-*-universal io" 2>&1)
dbg() { printf '%s' "$DBG" | python3 -c "import json, sys; d = json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
[ "$(dbg 'd["error"]')" = "None" ] || fail "the debug session failed" "$DBG"
case "$(dbg 'd["autorun"][0]')" in
  "set inferior-tty /dev/pts/"[0-9]*) : ;;
  *) fail "the launch configuration does not start with set inferior-tty" "$DBG" ;;
esac
[ "$(dbg 'd["stoppedLine"]')" = "7" ] || fail "the breakpoint on line 7 was not hit" "$DBG"
[ "$(dbg '"terminated" in d["events"]')" = "True" ] || fail "the debug session did not end" "$DBG"
ok "webfreak.debug: launched with set inferior-tty, stopped on line 7, then ended"
[ "$(dbg '"enter a=" in d["screen"] and "a*2=14" in d["screen"]')" = "True" ] \
  || fail "the program's terminal did not show the prompt and the answer to the 7 typed" "$DBG"
ok "the terminal showed the prompt, took the 7 typed and showed a*2=14"
[ "$(dbg '"enter a=" in d["console"] or "a*2=14" in d["console"]')" = "False" ] \
  || fail "the program's output reached the debug console" "$DBG"
[ "$(dbg '"controlling terminal" in d["screen"]')" = "False" ] \
  || fail "gdb could not make the terminal the program's controlling terminal" "$DBG"
ok "the program's I/O stays out of gdb's stream; the terminal is its controlling terminal"

# --------------------------------------------------------------------------
head2 "5. C++: g++, the standard library, gdb's pretty-printers, clangd"
# --------------------------------------------------------------------------
# The labs are in C and in C++: g++ is Debian's default, the same GCC as gcc.
GCCV=$(cexec 'gcc -dumpversion' 2>&1); GXXV=$(cexec 'g++ -dumpversion' 2>&1)
[ -n "$GCCV" ] && [ "${GCCV%%.*}" = "${GXXV%%.*}" ] || fail "g++ ($GXXV) is not the major version of gcc ($GCCV)"
ok "g++ $GXXV, the major version of gcc $GCCV"
OUT=$(cexec 'cd /work && g++ -std=c++20 -g -O0 -Wall -Wextra -pedantic -o cpp20 cpp20.cpp && ./cpp20' 2>&1) \
  || fail "the C++20 program (<vector>, <ranges>, <format>) did not compile or run" "$OUT"
[ "$OUT" = "evens=3 first=2" ] || fail "the C++20 program printed something else" "$OUT"
ok "g++ -std=c++20: <vector>, <ranges> and <format> compile and run (evens=3 first=2)"
# libstdc++6's printers are auto-loaded from /usr/share/gdb/auto-load, on the
# read-only root, by gdb's Python: `print evens` shows the elements, not the
# vector's three raw pointers.
OUT=$(cexec 'cd /work && gdb -batch -ex "break 9" -ex run -ex "print evens" -ex "info auto-load python-scripts" ./cpp20' 2>&1) \
  || fail "gdb on the C++ program failed" "$OUT"
case "$OUT" in
  *"Breakpoint 1, main ()"*"std::vector of length 3"*"{2, 4, 6}"*) : ;;
  *) fail "gdb did not stop in main or did not pretty-print the std::vector" "$OUT" ;;
esac
case "$OUT" in
  *"Yes"*"libstdc++.so."*"-gdb.py"*) : ;;
  *) fail "libstdc++'s pretty-printers were not auto-loaded" "$OUT" ;;
esac
ok "gdb breaks in main and prints the std::vector through libstdc++'s auto-loaded printers"
# The program's terminal of § 4 is not C-specific: the same debug session
# on a C++ program (iostream), through webfreak.debug's real adapter.
cexec 'cd /work && g++ -std=c++20 -g -O0 -o iocpp iocpp.cpp' >/dev/null 2>&1 || fail "g++ iocpp.cpp failed"
DBG=$(cexec "cd /work && /usr/lib/code-server/lib/node test-debug-io.js ${STATUSBAR_DIR} /opt/code-server/extensions/webfreak.debug-*-universal iocpp iocpp.cpp" 2>&1)
[ "$(dbg 'd["error"]')" = "None" ] || fail "the C++ debug session failed" "$DBG"
[ "$(dbg 'd["stoppedLine"]')" = "7" ] || fail "the breakpoint on line 7 of the C++ program was not hit" "$DBG"
[ "$(dbg '"enter a=" in d["screen"] and "a*2=14" in d["screen"] and "a*2=14" not in d["console"]')" = "True" ] \
  || fail "the C++ program's I/O did not go through its terminal" "$DBG"
ok "webfreak.debug on a C++ program: stopped on line 7, its I/O in the Program terminal only"
# clangd with the image's configuration only (no compile_commands.json):
# C++ gets -std=c++20 and resolves the standard library, C keeps -std=c17.
OUT=$(cexec 'cd /work && clangd --check=/work/cpp20.cpp 2>&1')
case "$OUT" in
  *"invalid argument"*|*"not allowed with"*|*"file not found"*) fail "clangd reports an error on the C++ file" "$OUT" ;;
esac
case "$OUT" in
  *"-std=c++20"*"All checks completed, 0 errors"*) : ;;
  *) fail "clangd did not parse the C++ file with -std=c++20 and no error" "$OUT" ;;
esac
ok "clangd on a .cpp: -std=c++20, <vector>, <ranges> and <format> resolved, 0 errors"
OUT=$(cexec 'cd /work && clangd --check=/work/clangd-c.c 2>&1')
case "$OUT" in
  *"-std=c++20"*) fail "clangd gave the C file the C++ flags" "$OUT" ;;
esac
case "$OUT" in
  *"-std=c17"*"All checks completed, 0 errors"*) : ;;
  *) fail "clangd did not parse the C file with -std=c17 and no error" "$OUT" ;;
esac
ok "clangd on a .c: still -std=c17, 0 errors"

# --------------------------------------------------------------------------
head2 "6. pytest: both forms, offline, no warning, its cache in /work"
# --------------------------------------------------------------------------
# The C labs whose `make test` runs `pytest`, and whose `make points` runs
# `python3 -m pytest`, falling back on `python3 -m pip install pytest`
# (2026-11-16). Debian's python3-pytest serves both forms for
# /usr/bin/python3 (`pytest` on PATH: § 2; no pip: § 3).
OUT=$(cexec '/usr/bin/python3 -m pytest --version' 2>&1) || fail "python3 -m pytest --version failed" "$OUT"
ok "/usr/bin/python3 -m pytest: $OUT"
cexec 'ls /usr/lib/python3/dist-packages/_pytest/__pycache__/*.cpython-313.pyc' >/dev/null 2>&1 \
  || fail "pytest's byte-code was not compiled at build time"
ok "pytest's byte-code compiled at build time (Python never writes on the root)"

# `make test` as the labs write it, then the `python3 -m pytest` form of their
# `make points`. -W error turns any warning into a failure, a cache that could
# not be written (PytestCacheWarning) included.
OUT=$(cexec 'cd /work/pylab && PYTEST_ADDOPTS="-W error" make test' 2>&1) \
  || fail "make test (pytest -vv --junitxml) failed" "$OUT"
case "$OUT" in
  *"tests/test_x.py::test_adds PASSED"*"tests/test_x.py::test_tmp_path PASSED"*"2 passed"*)
    ok "make test: pytest ran the compiled program through subprocess, tmp_path under /tmp, 2 passed" ;;
  *) fail "make test did not report test_adds and test_tmp_path as passed" "$OUT" ;;
esac
OUT=$(cexec 'cd /work/pylab && rm -f report.xml xml_key.ok && /usr/bin/python3 -m pytest -q -W error --junitxml=report.xml' 2>&1) \
  || fail "python3 -m pytest -q --junitxml failed" "$OUT"
OUT=$(cexec "cd /work/pylab && python3 -c 'import xml.etree.ElementTree as E; s = E.parse(\"report.xml\").getroot().find(\"testsuite\"); print(s.get(\"tests\"), s.get(\"failures\"), s.get(\"errors\"))'" 2>&1)
[ "$OUT" = "2 0 0" ] || fail "report.xml does not hold two passed tests" "$OUT"
cexec 'test -f /work/pylab/xml_key.ok' >/dev/null 2>&1 \
  || fail "the conftest's hook did not find the junitxml plugin's xml_key"
ok "python3 -m pytest -q --junitxml=report.xml: report.xml in /work, 2 tests, 0 failure; the conftest found xml_key"
cexec 'cd /work/pylab && test -d .pytest_cache && ls tests/__pycache__/test_x.cpython-313-pytest-*.pyc' >/dev/null 2>&1 \
  || fail ".pytest_cache or the rewritten test's byte-code is missing in /work"
ok ".pytest_cache and the assertion-rewritten byte-code land in /work"

passed
