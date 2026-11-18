# heig.codespace-statusbar

Extension baked into the `codespace/c-dev` student image of the heig-codespace
project. It adds, at the right of the status bar, the time left until the
assignment deadline and a « Fermer » button that takes the student back to the
portal. Since 0.4.0, in a Safe Exam Browser session (`CODESPACE_SEB=1`, and
then no return URL), the button gives way to the hint « Quitter : Ctrl+Q »:
SEB's own quit, with the wording of Quiz's (Ctrl+Q, ⌘Q on Mac), since the
button's new tab has no platform session inside SEB.

The countdown and the button come from the container environment
(`CODESPACE_DEADLINE`, `CODESPACE_RETURN_URL`, `CODESPACE_ASSIGNMENT_NAME`,
`CODESPACE_SEB`), set by the portal's `podman run`. A third item warns when GitHub refused the
student's last push (ADR-078 §6: the relay never forces; pull, then push
again): it polls `GET <origin>/push-status` on the portal's git channel, the
workspace's `origin` remote, every 30 s. No other network access, no
telemetry, no dependency, no credential.

Since 0.3.0 the same answer may name a teacher's update (ADR-132 §11): the
item "Update from your teacher" offers to merge it into the student's branch, a
merge commit of the student's, applied cleanly or not at all
(`update.js`, which needs no `vscode`).

Since 0.2.0 it also gives every gdb launch of webfreak.debug the debugged
program's own terminal, "Program" (`debugIo.js`): without it the program's
stdin and stdout stay on gdb's pipes, where the student can neither see what
it prints nor type what it reads.

Full documentation: `images/c-dev/README.md` of the heig-classroom repository.
