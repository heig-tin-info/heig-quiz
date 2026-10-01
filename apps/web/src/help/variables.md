# Random values

Give each student their own numbers: declare variables, write them in the
question, and every attempt draws its own values. Multiple choice, short
answer and fill-in-the-blanks questions take them.

## The table

One row per variable, read from top to bottom: a row reads only the rows
above it.

- **Name**: a letter or `_`, then letters, digits or `_` (`h`, `g`, `v0`).
- **Expression**: `randint(10, 100)` (an integer, both ends included),
  `uniform(1, 2)` (a real number), `choice([3.71, 9.81, 24.79])` (one of a
  list), or a formula of the rows above: `sqrt(2*h/g)`. The functions are
  `sqrt`, `abs`, `exp`, `log`, `round`, `floor`, `ceil`, `min`, `max`,
  `sin`, `cos`, `tan` and their kin; `pi` and `e`; `^` is the power.
- **Format**: an integer, a number of decimals or of significant figures.
  A variable IS its formatted value: `g` at 2 decimals is 9.81, and every
  formula below reads 9.81.
- **Condition** (optional): `t > 1`. A draw where it is false is drawn
  again.

## In the question

Write `[[h]]` or `[[sqrt(2*h/g)]]` anywhere: the statement, the choices,
the explanation, a blank (`{{#[[t]]:1%}}`), the value and the tolerance of
a short answer's number. `\[[` writes the brackets themselves.

A short answer's key is a number: give it a tolerance of at least half the
step of its format (0.005 for 2 decimals), or the exact answer is marked
wrong. For a multiple choice, write a wrong choice as the formula of a
classic mistake (`[[sqrt(h/g)]]`): choices that read alike are drawn again.

## Five draws

Under the table, five draws as students will get them, computed by the
server exactly as publication checks them. Open one to read it as a
student, with its key.
