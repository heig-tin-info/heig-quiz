# Results

## Students

The figures first: mean, median, standard deviation, pass rate, and the
distribution of the grades. Then one row per student — points, grade to the
tenth, time used, and the state of their attempt: absent, not started, in
progress, submitted, or expired at the deadline.

The grade is 1 + 5 × points / total on the Swiss 1 to 6 scale, capped at 6
and rounded to the tenth. The total leaves out the bonus questions, whose
points only lift a student. It is computed from the validated gradings, so
adjusting one in the grading panel moves it.

## Questions

One block per item, in the order of the quiz: the statement, the answer key,
the explanation, how the answers were spread and the success rate — per
choice for a multiple choice, per test case for a code question. It is meant
to be scrolled through while going over the paper in class.

## Export

**Export CSV** gives one line per student with the points of each item, the
total and the grade; a bonus question's column is marked `(bonus)`. Semicolons and a UTF-8 byte-order mark, so Excel opens
it without a dialog.

## Publishing

**Publish results** shows every student their grade, and whatever the
feedback policy of this evaluation allows — their answer, the key, the
explanation, your comment. If a grading changes afterwards, the page says so
and asks you to publish again. **Withdraw** takes the grades back out of
sight until you do.
