# Parameterized questions

A parameterized question draws its own numbers for every attempt. You write the question once, with variables in place of the values, and students sitting next to each other get different numbers, each graded against their own key. One question replaces a family of near-copies, and its statistics pool every instance.

Multiple choice, short answer (with a number key) and fill in the blanks take variables. The other types do not, and a live poll refuses a parameterized question: a projector and thirty phones must show the same thing.

## An example: the falling ball

A ball is dropped from a height `h` on a planet of gravity `g`; how long does the fall last? From rest, `h = ½ g t²`, so `t = √(2h/g)`.

In the editor, under the question's form, open **Random values** and add three variables:

| Name | Expression | Format |
| --- | --- | --- |
| `h` | `randint(10, 100)` | Integer |
| `g` | `choice([3.71, 9.81, 24.79])` | 2 decimals |
| `t` | `sqrt(2*h/g)` | 2 decimals |

with the condition `t > 1.5`, so that no fall is too short to be interesting.

Then write the variables into the question between double brackets:

- the statement: `A ball is dropped from [[h]] m on a planet where $g = [[g]]\,m/s^2$. How many seconds does the fall last?`
- the key, a **Number** accepted answer: value `[[t]]`, tolerance `0.01`;
- the explanation: `From rest, $h = \tfrac12 g t^2$, so $t = \sqrt{2h/g} = [[t]]$ s.`

A student may read "dropped from 42 m where g = 9.81 m/s²" and be expected to answer 2.93; their neighbour reads 87 m and 3.71 m/s², and is expected to answer 6.85.

## The variables

The table is read from top to bottom, and a row reads only the rows above it.

- **Name**: a letter or `_`, then letters, digits or `_`. A name cannot be a function (`sqrt`) or a constant (`pi`).
- **Expression**: a draw — `randint(a, b)` for an integer, both ends included, `uniform(a, b)` for a real number, `choice([…])` for one value of a list — or a formula of the rows above. The functions are the usual ones: `sqrt`, `abs`, `exp`, `log`, `round`, `floor`, `ceil`, `min`, `max`, `sin`, `cos`, `tan` and their kin, with the constants `pi` and `e`. The power is `^` (`h^2`), as on a calculator, and every product is written with `*`.
- **Format**: Automatic (up to six significant figures), Integer, 1 to 6 decimals, or 1 to 6 significant figures. A variable **is** its formatted value: `g` at 2 decimals is 9.81, and every formula below it reads 9.81. Numbers are written with a dot in every language; a student may answer with a comma or a dot.
- **Condition**, optional: a draw where it is false is drawn again, up to 100 times.

## Writing them into the question

`[[h]]` writes a variable with its format; `[[sqrt(h/g)]]` writes an expression, with up to six significant figures. Both work in the statement, the choices, the key, the blanks (`{{#[[t]]:1%}}`), the explanation, inside a formula (`$[[g]]$`) and inside code. To write two brackets as such, put a backslash before them: `\[[`.

Brackets mean something only in a question that declares variables. A static question keeps its `[[1,2],[3,4]]` as text.

### Short answer

The key of a parameterized short answer is a **Number** accepted answer: its value and its tolerance take a number or a reference such as `[[t]]`. A text key computed from variables is refused, because text equality cannot match a number computed, then formatted.

The tolerance must cover the rounding of the key. A key `[[t]]` at 2 decimals is rounded to the nearest 0.01, so a student who computes the exact value can be up to 0.005 away from it: publication refuses a tolerance below half the step of the key's format (0.005 here, 0.5 for an integer). A relative tolerance is checked the same way on the drawn keys.

### Multiple choice

Write a wrong choice as the formula of a classic mistake: `[[sqrt(h/g)]]` (the forgotten factor 2), `[[2*h/g]]` (the forgotten square root). When two choices of a draw read the same, or are within 1 % of each other, the draw is made again.

## Five draws

Under the table, **Five draws** lists the values of five draws, computed by the server exactly as publication checks them: what you read is what students can get. Open a draw with its eye to read it as a student would, with its explanation below it; **Show answers** gives its key. The draws follow each save of the draft; while the draft does not validate, the section says to fix its issues first.

## Publication and what students get

Publication draws the variables 200 times and refuses the question when an expression fails, when a name is unknown, when a `[[` is not closed, when the condition is never met, or when a draw takes too long. Each issue is shown on its row, or on the text that holds the faulty `[[…]]`.

The question list shows a **Parameterized** pill on such a question, and so does the editor's header once a version with variables is published.

A student's values are drawn when their attempt starts and kept with it: the paper, the review, the results and a regrade with a newer version all show the same numbers. A retake draws new ones.
