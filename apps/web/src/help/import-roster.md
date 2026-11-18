# Add students

## What this does

Fills the classroom roster — students then claim their seat automatically at
their first sign-in (matching e-mail).

## How to import

Drop an **Excel or CSV** export. The last name, first name, e-mail and
extra-time columns are detected permissively: accents and case are ignored,
French and English headers both work, the header does not have to be on the
first line, and extra columns are ignored.

The extra-time column is optional. It is recognized under names like
`bonus`, `temps supplémentaire` or `extra time`, and accepts `25`, `25 %` or
`0.25`.

## One student

Type a few letters of a name: the list offers the students of your school who
already signed in, with their school address. Pick one, then **Add**. Someone
the list does not show is added by their e-mail address alone; the line then
takes its name at their first sign-in. A name you typed or imported is never
replaced.

## What happens on re-import

The import is atomic: a single bad line rejects the whole file, and nothing
is written. Re-importing the same list is safe — existing seats keep their
claim, only names are refreshed, and nothing is ever deleted implicitly.
A sheet WITHOUT an extra-time column never clears an accommodation you set
by hand.
