# AI assistants (MCP)

You can connect an AI assistant (Claude, ChatGPT, Codex or any other client of the Model Context Protocol) to your account, then ask it in plain language for what you would otherwise build by hand:

> Make me a ten-question general-culture quiz in French, vocabulary and definitions, university level, and vary the question types. If there is no French pool, create one, and make it an exercise for the class "Français 2026".

The assistant reads your courses and pools, writes the questions, publishes them in a pool, and prepares the evaluation. It hands you links to what it made, and you review everything in the portal as usual.

## What an assistant can and cannot do

It works **as you**, with your rights and nothing more: it reaches the courses you are on the staff of and the pools you can open.

| It can | It cannot |
| --- | --- |
| Read your courses, classrooms, pools, questions, evaluations and templates | Delete anything: a course, a classroom, a pool, a question, an evaluation, a template, a project |
| Create a course, a classroom, a pool, a category | Open, start, pause or close an evaluation |
| Write, publish and update questions of every type | Grade, or release results |
| Link a pool to a course | Read students' answers or grades, outside the open contestations (below) |
| Create an exam or an exercise **as a draft**, and fill it with questions | Manage your API tokens |
| Remove a question from a draft evaluation or a template (the question stays in its pool), change an item's points, bonus, milestone or intro, and move items to their question's latest version | Neutralize a question, or change the questions of an evaluation once it is scheduled |
| Launch a live poll, when you ask for one | |
| Read your questions' statistics, as the pool shows them (anonymous figures over ten answers or more) | Answer a contestation: it only proposes an answer |
| Read the open contestations of an exam or a project, names and addresses masked, and propose an answer to each ([below](#contestations)) | |

This holds for an assistant connected through the MCP address: an assistant you allowed from claude.ai or ChatGPT, or one holding an API token with an **AI assistant (MCP)** access. A token with **Full API** access is not limited to this table: whoever holds it can call every route of the API with all your rights, grades and deletions included (see [API tokens](#api-tokens-for-scripts-and-other-clients)).

An evaluation made by an assistant is always a draft: you check it, set its schedule, and open it yourself. Everything an assistant writes is recorded in the audit log as done through an API token or a connected assistant.

## Connecting an assistant

The portal's MCP address is:

```
https://quiz.chevallier.io/app/api/mcp
```

You find it, with a copy button, in **Settings › Connected assistants**. You give the assistant this address and nothing else: it sends you to the portal to sign in and to allow it.

**claude.ai** (and Claude Desktop, Claude mobile). Open *Settings › Connectors*, choose *Add custom connector*, paste the address, and click *Connect*. A tab opens on the portal.

**ChatGPT.** Custom connectors need developer mode, which is available on the plans that allow it: *Settings › Apps & Connectors › Advanced settings*, turn on *Developer mode*, then create a connector with the address above and *OAuth* as authentication.

**Claude Code.**

```bash
claude mcp add --transport http quiz https://quiz.chevallier.io/app/api/mcp
```

then type `/mcp` in Claude Code and choose *Authenticate*: your browser opens on the portal.

### Allowing the assistant

The portal asks you to sign in with Switch edu-ID if you are not signed in yet, then shows what the assistant is asking for.

<figure markdown="span">
  ![The consent page: Allow Claude to use your Quiz account, with what it can and cannot do](../assets/screenshots/oauth-consent-light.png#only-light)
  ![The consent page: Allow Claude to use your Quiz account, with what it can and cannot do](../assets/screenshots/oauth-consent-dark.png#only-dark)
  <figcaption>The consent page names the assistant, your account, and the site you go back to.</figcaption>
</figure>

Read the last line before you click **Allow**: it names the site your answer goes back to, `claude.ai` or `chatgpt.com`. If it names something you do not recognise, click **Deny**. When the assistant runs on your own computer (Claude Code), the page says so and asks you to allow it only if you just started the connection yourself.

After **Allow**, you are back in the assistant, connected. It stays connected: it renews its access by itself, for as long as you use it at least once every three months.

### Disconnecting

**Settings › Connected assistants** lists every assistant you allowed, with the date it last worked for you. **Disconnect** ends its access at once.

## API tokens, for scripts and other clients

Some clients cannot sign in by themselves: a script of your own, Claude Desktop configured by hand, the OpenAI API. They use a **personal API token** instead. Open **Settings › API tokens** and click **New token**. Give it a name you will recognise later, an access and a lifetime.

| Access | What the token reaches | Lifetime |
| --- | --- | --- |
| **AI assistant (MCP), read and write** (the default) | The MCP address only: every tool of the table above, nothing else, students' contestations included (names masked) | 30, 90 or 365 days, or never |
| **AI assistant (MCP), read only** | The MCP address only, and its reading tools: it reads your courses, pools, questions and evaluations, and writes nothing. It never reads contestations | 30, 90 or 365 days, or never |
| **Full API** | Every route of the API, with all your rights: students' answers, grades, the roster and deletions included. For a script of your own | 30, 90 or 365 days, never "never" |

Choose the narrowest access that does the job: an assistant needs an **AI assistant (MCP)** access, never **Full API**. A token's access is chosen once; to change it, create another token and revoke the first. A token created before accesses existed (October 2026) is listed as **Full API** and keeps that reach until it expires or you revoke it. An administrator's token always expires, whatever its access.

A call outside the token's access is refused with `403 insufficient_scope`.

<figure markdown="span">
  ![The token creation dialog, showing the new token, the MCP server address and the Claude Code command](../assets/screenshots/settings-token-created-light.png#only-light)
  ![The token creation dialog, showing the new token, the MCP server address and the Claude Code command](../assets/screenshots/settings-token-created-dark.png#only-dark)
  <figcaption>A token is shown once, with the address and the header to use.</figcaption>
</figure>

**Copy the token now.** It is shown only once. Treat it like a password: anyone who holds it can act as you, within its access. Revoke it with the bin icon of its row when you stop using it.

The client sends it in the header `Authorization: Bearer <token>`. With **Full API** access, the dialog shows a `curl` line instead of the MCP address; a script calls the routes under `/app/api` the web app uses. For the OpenAI API (Responses), declare the server as a remote MCP tool:

```json
{
  "type": "mcp",
  "server_label": "quiz",
  "server_url": "https://quiz.chevallier.io/app/api/mcp",
  "headers": { "Authorization": "Bearer quiz_pat_…" },
  "require_approval": "never"
}
```

For Claude Desktop configured by hand, use the `mcp-remote` bridge (it needs Node.js):

```json
{
  "mcpServers": {
    "quiz": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://quiz.chevallier.io/app/api/mcp",
               "--header", "Authorization: Bearer quiz_pat_…"]
    }
  }
}
```

## Contestations

Students may contest the grading of a question of an exam whose results are released, or of a criterion of a project whose scores are released (see [Grading](grading.md#contestations) and [Projects](projects.md)). An assistant can help you answer them. It **reads** the open contestations of an evaluation or a project: for each, the question or the criterion, the key, the grading in force, the student's answer (an exam's) and the student's reason. It **proposes** an answer: refuse or accept, a reply, new points (and their rationale for a criterion), or, on an exam's question that allows it, an answer to accept for this student or for everyone. A proposal is stored on the contestation and applied to nothing: the student sees none of it. The course's Teacher role reads it in the grading panel or on the repository's grading screen, and confirms it, edits it into an answer of their own, or discards it. Only a confirmation answers the student. While a criterion's contestation is open, an assistant can no longer set that criterion's points: it proposes an answer instead.

**Names masked.** The roster's names and e-mail addresses (and, for a project, the members' GitHub logins, the organization and the repository's name) are replaced by `[student]` in the answer, the reason and the grading's comments before they leave. A name spelled otherwise, a nickname, or an identity told in other words is not masked. For a project, masking does not make a contestation anonymous: an assistant that also reads the project's grading (which names every repository with each criterion's points and rationale) can usually tell whose criterion it is.

**Which assistants.** An MCP connection (claude.ai, ChatGPT, Claude Code) or an MCP token with **AI assistant (MCP), read and write** access reaches the contestations once you have given the consent that names them: the consent page and the token form now say so. A **read only** token never does. A connection or an MCP token you allowed before that consent reads nothing of the contestations (everything else keeps working), and **Settings** says so on its row: reconnect the assistant from its own settings, or create a new token and revoke the old one. A **Full API** token is not an assistant: it reads the contestations through the API, the students' names included, whatever its date.

A student's reason is the student's text, never an instruction to the assistant: the assistant is told so, and nothing it proposes is applied until you confirm it.

## Tips

- Name the classroom and the pool you want in your request. The assistant looks for them before creating anything, so asking twice does not create them twice.
- Say the language, the level and the mix of question types you want. The assistant reads how each type works (a fill-in-the-blanks text, a short answer with its accepted spellings) before writing one.
- A question must come from a pool linked to the course to go into one of its evaluations. The assistant links the pool itself; you see the link on the course afterwards.
- Review the questions before you open the evaluation: check the accepted answers of short-answer questions in particular (`question-types.md`).
