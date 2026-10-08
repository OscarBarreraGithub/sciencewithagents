# LaTeX and PDF reader

## Equations in chat

Chat renders math automatically in manager, worker, QUARK, resource and shared editor
conversations, including saved replies. Use `\( ... \)` inline and `\[ ... \]` for displayed
equations; these are also the app's agent instructions. `$...$`, `$$...$$` and `math` code
fences are supported for existing messages. Ordinary code fences and inline code stay literal.
Wide displays scroll inside the message; unusually wide inline formulas can be panned in
their paragraph. Rendering and fonts are local and spend no model tokens.

The renderer uses [KaTeX](https://katex.org/), with accessible MathML alongside the visual
equation. Incomplete streamed equations stay as text until closed; malformed math stays
readable instead of breaking the chat. Plain prices such as `$5 and $10` stay text. This is
math typesetting, not a full TeX compiler: custom preambles/packages belong in a `.tex` report
opened with the reader below. Source messages are retained unchanged.

## Read documents

Open **Apps → LaTeX** on a computer with recent documents, or **? → LaTeX / PDF reader**
to get started. Browse the selected computer’s folders, choose a `.tex` or `.pdf`,
or reopen a recent document. PDF files need no compiler. LaTeX builds on the computer;
the phone displays the result. Both devices use the existing authenticated connection.
If macOS blocks an iCloud or protected folder, allow sciencewithagents folder access in
System Settings → Privacy & Security, then retry. The app does not bypass operating-system permissions.

When LaTeX source is available, **Reading** opens a reflowing, phone-width document with
adjustable text size. Paragraphs, headings, tables and figures fit the screen; long equations
scroll individually, with a visible “More equation” cue on the hidden side. Standard numbered equations count unlabeled rows too; manual tags render once. Reading position is saved locally. A PDF with a same-name `.tex` beside
it also offers Reading mode. **Original PDF** retains fixed pages, fit-to-width, whole-page
view, zoom buttons, pinch zoom, page navigation, selectable text and download. A manager’s document link opens over the
conversation. Back, browser Back, or a right swipe at fitted width returns to the same
chat position and keeps the draft. When zoomed in, horizontal gestures pan the page.
Reading position is also remembered locally for recent documents.

## Format for phone

Use **Format for phone** in Reading mode to request a separate AI-formatted copy. The
selectable model defaults to the latest Sonnet family through central model policy.
It uses an ordinary QUARK-supervised turn, shows queue/failure state and never overwrites
original source or PDF. Read either version from the same viewer. Source changes invalidate
an older copy; deterministic checks protect labels, references, tags and the preamble,
not arbitrary mathematical equivalence. Follow [phone LaTeX conventions](TEX_AUTHORING.md)
across manager and worker reports. Larger text and some matrices still need local scrolling.

## Share from a manager

Use `dock_document` with a project-relative path, for example
`{"path":"reports/thermal.tex"}`. Put its returned `href` in a Markdown link in the reply.
Managers may also register a report from their managed workspace; workers register relative
to their own workspace. Saved manager messages with local `.tex` or `.pdf` Markdown links
open in the app too: the server checks the recorded message and its project/workspace boundary,
then issues a document ID. The browser never submits an arbitrary file path. Interactive resource assistants can share
reports from their workspace too. Registration does not build or change the source; opening
the link starts the build. Saved document links also work in shared VS Code chat Markdown.
An independent editor agent needs a document already registered in this app to use such a link.

## Reading mode setup and limits

Reading mode uses installed [Pandoc](https://pandoc.org/installing.html); local PDF figures
also need Poppler (`pdftoppm`). On macOS, the setup agent can install missing tools with
`brew install pandoc poppler`. This computer-side conversion spends no model tokens.
The browser sanitizes converted HTML and typesets equations with local KaTeX. Converter
sandboxing blocks network/file access; a bounded loader supplies local includes and image
assets from the registered folder. Source files are never edited.

Reading mode interprets LaTeX content, not every package's print layout. Complex package
commands may need Original PDF; missing figures are marked. An ordinary PDF without its
LaTeX source keeps the PDF viewer rather than claiming reliable mathematical reflow.
Includes outside the registered folder are refused in Reading mode. Inputs are bounded to
100 files / 8 MB combined, conversions to 30 seconds per operation, with one reading build
at a time. Missing conversion tools have a retry action; the original PDF stays available.

## Compiler and build boundaries

Install **Tectonic** or **TeX Live with latexmk** if LaTeX compilation is wanted. Setup detects
existing installations, including Homebrew and TinyTeX on Mac; ordinary PDFs work without
these optional tools. The app prefers installed latexmk, otherwise Tectonic. Missing compilers
or packages are reported with build details and a retry action, not hidden by a blank viewer.

Compilation uses the source folder as its working directory, so relative includes, figures
and shared preambles in parent folders resolve normally. Generated files go into private
build storage. Builds ignore latexmk configuration files, disable shell escape and restrict
TeX output paths; auxiliary files are not written beside the source. TeX documents requiring
external commands are not supported. Source files must already be downloaded on the computer.

Builds run one at a time, with a two-minute compiler limit and 50 MB per source/PDF file.
A failed build keeps the previous successful PDF. Rebuild refreshes included files and figures
even when the main `.tex` did not change. A stopped app marks unfinished builds for retry.
The compiler can read supporting files accessible to this computer; these controls are not
an OS sandbox for hostile TeX or a promise that every document package is installed.

Private paths, compiled PDFs and build state stay under the selected installation’s ignored
`data/`. Web clients select opaque file/folder IDs; they cannot supply shell commands or paths.
Compilation spends no model tokens. It is a small, bounded local service, not an agent turn.

The browser renderer uses [Mozilla PDF.js](https://mozilla.github.io/pdf.js/), licensed under
Apache-2.0. Its worker, fonts and character maps are served locally with the app.
