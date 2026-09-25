# Multiple-answer scoring

A question with **one** correct answer is always scored all or nothing.
These five policies decide what a question with **several** correct answers
is worth when the student ticks only some of them.

## Three levels

Each one overrides the one above it.

- **Your preference**, in Settings — it seeds the evaluations you create, and nothing else: changing it never moves a quiz that already exists.
- **The evaluation**, under its advanced options — the policy every one of its questions uses unless that question says otherwise.
- **The question** itself, "inherited" by default, free to name a policy of its own.

## The five policies

`C` is the number of correct choices, `W` the number of wrong ones, `c` how
many correct ones the student ticked and `w` how many wrong ones.

- **Exact** (all or nothing) — 1 if the ticked set is exactly the key, 0 otherwise.
- **True/false** — every choice is its own true/false question: `(c + (W - w)) / (C + W)`. Ticking nothing already scores `W / (C + W)`.
- **Distance** (discordances) — count the choices the student got the wrong way round, in either direction: `d = (C - c) + w`. No discordance scores 1, one scores 0.5, two score 0.2, three or more score 0.
- **Symmetric** — `c/C - w/W`: a wrong tick costs exactly what a right one earns, so ticking at random is worth nothing on average.
- **Ripkey** — `c/C`, cancelled to 0 by a single wrong tick. It pays a student who ticks only what they are sure of.

No policy ever goes below zero: answering is never worse than not answering.

## Negative marking

An evaluation may switch on **negative marking**, under its advanced options.
It then scores **every** choice question of that evaluation the same way,
whatever policy the question names, one answer or several:

- one correct answer among `n` choices: the right one earns 1, a wrong one costs `1/(n - 1)`;
- several correct answers: `c/C - w/W`, the symmetric formula, not floored — it may reach -1;
- no answer (nothing ticked, "I won't answer", cleared): 0.

Guessing at random is worth 0 on average, so it no longer pays. The points
of a question may be negative and are shown as such; the evaluation's total
never goes below 0. Students are told in the waiting room and on each
choice question.
