# Science with Agents

Keep your research together across AI conversations. Your agent maintains a lab notebook, saves work in Git, and leaves enough context for another conversation or collaborator to continue.

Use the model and interface you already work with. Start with one project; add reviews, other agents, or periodic checks when useful.

## Get started

Give your agent this request:

> Use Science with Agents from https://sciencewithagents.com. Read its instructions, find any existing setup, and help me start or continue my projects. Keep my personal prompts private.

The agent follows [the setup guide](docs/setup.md). It can help you install missing tools, connect your own GitHub account, or work through screenshots and browser access where supported. You only need to handle choices and sign-in steps that require you.

You can also clone this repository and open it in your agent:

```sh
git clone https://github.com/OscarBarreraGithub/sciencewithagents-starter.git "Science with Agents"
```

## What you get

- **A notebook beside the research.** What you tried, what happened, why you changed course, and where to resume.
- **A history of contributions.** Git records the changes. The notebook credits producers and reviewers. Private native records, when available, let you inspect the original tool calls and agent exchanges.
- **Several projects with a clear overview.** Project managers do the work. An optional central orchestrator relays requests and tells you what needs attention.
- **Reusable methods.** Import a colleague's literature search, review procedure, cluster instructions, or plotting recipe. Ask what is active or create a new workflow in ordinary language.
- **A small companion for your paper.** Preserve the assumptions, conventions, derivations, code, inputs, and decisions behind each result. Export the relevant scientific files and reproduction instructions when ready to submit. Personal chats stay out.

## Try asking

| You want to… | Say… |
| --- | --- |
| Continue research | “Where did we leave off?” |
| Add existing work | “Add the project in this folder.” |
| Understand a decision | “Who changed this convention, when, and why?” |
| Coordinate projects | “What needs my attention across my projects?” |
| Reuse a method | “Use this group's workflow for our literature search.” |
| Work with someone else | “Leave this question for my collaborator.” |
| Prepare a submission | “Collect the evidence needed to reproduce this paper.” |

## Find your way

```text
AGENTS.md       Entry instructions for the agent
docs/           Setup, working instructions, and the paper
Workflows/      Optional methods, including your imports
My Projects/    Your projects and references to existing work
```

[Guide](docs/README.md) · [Project structure](docs/setup.md#project-structure) · [Paper PDF](docs/paper/science-with-agents.pdf) · [LaTeX source](docs/paper/science-with-agents.tex) · [Scope and checks](docs/coverage.md)

This is an instruction kit. It does not run a server, keep a sleeping computer awake, or automatically connect every chat interface. Setup checks what your chosen tools can actually do. Native recording and completion checks need to be established for that host; the docs distinguish those steps from capabilities already verified.

The [earlier application](https://github.com/OscarBarreraGithub/sciencewithagents) remains available separately. This repository contains the smaller, instruction-based method.
