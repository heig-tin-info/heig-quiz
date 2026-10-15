## In short

- You sign in with Switch edu-ID. Quiz has no password of its own.
- The teaching staff of your course see your work in that course. Other students never see your grades (except your teammates, for a group project's shared score), nor your answers under your name.
- What you do is kept until your teacher deletes the evaluation, classroom or course it belongs to. A few kinds of data are deleted sooner, automatically; others, your account first, are never deleted automatically (see *How long it is kept*).
- Some of your answers and some of your code are sent to an AI model (Anthropic), usually with names masked, to help your teacher grade; your teacher decides the grade. Your teacher's help assistant may send your name and final results (see *Artificial intelligence*).
- No advertising, no audience measurement beyond the hours of activity, no tracking script. Nothing is sold.

## What is recorded

### Your account

At each sign-in, Switch edu-ID sends your name, your e-mail addresses, your edu-ID identifier and the address of your picture. Quiz also keeps everything edu-ID released at your last sign-in, your affiliations included, to diagnose sign-in problems; it is shown nowhere. It keeps your preferences (language, theme, notifications) and, if you link one, your GitHub account.

### Your place in a class

Your teacher imports the class list: your name, your school address, any extra time you were granted, and a note that only the teaching staff see.

### Evaluations

Your answers, when you start and hand in, your grades and your teacher's comments. Each attempt keeps a short journal: reconnections, pauses, time added, code runs.

**Leaving the page and pasting.** When an evaluation's conditions say *Leaving the page and pasting from outside are recorded*, Quiz records when you leave the evaluation page and when you come back, and when you paste a text copied outside it: its length, never its content. Nothing is blocked. Your teacher sees this record.

The time you spend on each question is never shown to anyone, you or your teacher. It only feeds anonymous statistics about the question.

If you sit an exam on one of the school's kiosk Chromebooks, Quiz records which station you used for which exam.

### The drill

For each question you practise: how you rated it, whether you were right, the time it took, your answer, and whether you used a touch screen or a mouse.

Your teacher sees your drill activity in their classroom: the questions you practise, your sessions, at what times of the week you practise, and your progress. You can leave the drill of a classroom at any time. Nothing new is counted after that; what was recorded before stays visible to your teacher, who also sees that you left.

### Projects and GitHub

When a course uses GitHub projects: the repository you accepted, the GitHub account you linked, the time of each push, the results of the automatic tests, your score and your teacher's comment. For a project graded by criteria, also what each graded commit produced (test results, outputs, files) and the points and explanations given for each criterion.

If you open a project in the online workspace, each launch is recorded, and the workspace keeps your name, your e-mail address and your files.

### Polls

Your answers to a poll. If you join a poll without an account, a pseudonym you choose and a cookie of your browser.

### When you use the platform

The hours in which you used Quiz (one mark per hour, nothing more precise) and the time of your last activity. The administrator reads the hours only as a number of people per hour, never person by person, and sees the last activity of each account.

## Why

To give you access to your classrooms, to run the evaluations (the clock, extra time, saving your answers), to grade and publish the results, to run the projects and the drill, to send you the notifications you chose, to compute statistics for your teachers, and to understand and fix problems.

## How long it is kept

By default, what you do in a course is kept until your teacher deletes the evaluation, the project, the classroom or the course it belongs to. Nothing is deleted automatically when you finish your studies. If you are removed from a class list, your answers, grades and drill activity in that classroom stay until the classroom is deleted.

Some data is never deleted automatically: your account, with your e-mail addresses and what edu-ID sent; the audit log, which records actions such as sign-ins, class list changes and gradings, with names; the log of calls to the AI model, which names the person each call was made for (never its content); your notifications; which kiosk station you used for which exam; a poll pseudonym without an account; and your files in the online workspace.

Some data is deleted automatically:

| What | Deleted |
| --- | --- |
| Leaving the page and pasting during an evaluation | When the grades are published; six months after the evaluation closed if they never are |
| Your drill activity | Five years after each review |
| The hours in which you used Quiz | After eight days |
| The files, commits and test outputs kept to grade a project by criteria | Six months after the project's results are published (the list of tests and their results stays) |
| The content of GitHub's messages about your repositories | 30 days after they arrive |
| A teacher's conversations with the help assistant, which may quote your name or grade | 30 days after each exchange |

Deleted data stays in the platform's backups for about four more months. That period holds only while the oldest backups are removed as planned, which is done by hand. The daily copies of the database kept on the server itself are not encrypted; the copy kept in Finland is.

## Who sees what

- **You**: your classrooms, your answers, and your results and feedback once your teacher publishes them.
- **Other students**: never your grades or your picture, and never your answers under your name. In a group project, your teammates share the repository and see its score. When a teacher shows the correction of an exercise, a poll's votes or the results in class, answers appear without names; in a very small class, or from an answer quoted as typed, others may still guess whose it is.
- **The teaching staff of your course** (its teachers and assistants): everything you do in that course, past years included: your answers, grades, attempt journal, drill activity and project repositories, and your progress live during an evaluation.
- **Teachers who can read a question** you answered in an exam: only statistics over all the students who answered it, never with fewer than ten answers, never your name.
- **The administrator of the platform**: the list of accounts with their picture and last activity, and the hours of use as counts. To reach a course, the administrator turns on special rights that last one hour and are recorded. To help you with a problem, an administrator may open a session in your name: it lasts at most an hour, cannot answer or submit anything for you, and is recorded under the administrator's name.
- **The people who run the servers** can technically reach all the data, through the machines themselves.

## Artificial intelligence (Anthropic)

Quiz sends some content to an AI model of Anthropic, a company of the United States, through one gateway that records every call (never its content). No model is called while an evaluation runs, except in a brainstorm.

- **Essay and diagram questions**: after the evaluation closes, your answer is sent, without your name, so that the model proposes a grade. Your teacher reviews it and decides. You read only the comment your teacher writes or accepts.
- **Projects graded by criteria**: the files the criteria name, the test results and the build outputs of your repository are sent, with names, e-mail addresses and GitHub logins masked. Your teacher validates the points of each criterion; you read the explanations, marked provisional until the results are published.
- **The final review of a project**: some projects run a final review that sends your code to an AI model (Anthropic), from your repository's checks on GitHub, on the organization's account, outside Quiz.
- **Brainstorms with AI assistance**: the model reads the ideas live, the names of the class masked. If you join without an account, your idea is sent as you typed it; the page tells you before you send it.
- **Your teacher's help assistant**: when your teacher asks it about their classroom, your name and your final results may be sent, not masked. Such a name may remain up to 30 days in your teacher's saved conversation, even if you leave the class.

Masking replaces the names Quiz knows. A name written differently, or someone else's name in your answer or your code, is sent as written.

## Other services

- **Switch edu-ID** (Switzerland): signing in.
- **Hetzner** (Germany and Finland): the servers. The application, the database and its backups are in Nuremberg, Germany. The code you run for a question is executed in Helsinki, Finland, without your name. The online project workspace runs there too, with your name, your e-mail address and your files, and so does the encrypted copy of the backups.
- **GitHub** (United States, Microsoft): for courses with GitHub projects, the repositories created for you and the invitations of your linked account. Deleting a project in Quiz does not delete its repositories on GitHub; they belong to the course's organization.
- **E-mail and Microsoft Teams**, if you receive notifications there: titles and names of classrooms, never a grade or the content of a question. E-mails go through Scaleway, in France.

Quiz loads no script, font or image from another company: everything comes from its own server.

## Your rights and questions

- **See your data**: your profile in **Settings**; your results and feedback once published.
- **Correct it**: your name and address come from edu-ID and are updated at each sign-in. A mistake in a class list is corrected by your teacher.
- **Remove it yourself**: your profile picture, your GitHub link and your Teams link, in **Settings**.
- **Stop the drill** of a classroom, from your drill.

For any other request (a copy of your data, a correction, a deletion), turn first to the teacher of your course.
