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

In **Open an arXiv paper**, paste an arXiv link or ID and choose **Open paper**.
The selected computer fetches the source and original PDF, shows progress and opens the
existing reader. An interrupted reply can be retried safely; reloading this tab follows
an import already in progress. Imported papers stay in Recent documents with their version.
PDF-only papers open the original with a note explaining that Reading needs source.
Importing and deterministic Reading make no model call.

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
When a simple table with one complete header row overflows a narrow Reading column,
it uses labeled card rows,
retaining full header labels, units and original cell order. Merged or ambiguous tables
retain their original scrollable layout.

## Format for phone

Use **Format for phone** in Reading mode to request a separate AI-formatted copy. The
selectable model defaults to the latest Sonnet family through central model policy.
It uses an ordinary QUARK-supervised turn, shows queue/failure state and never overwrites
original source or PDF. Read either version from the same viewer. Source changes invalidate
an older copy; deterministic checks protect labels, references, tags and the preamble,
not arbitrary mathematical equivalence. Follow [phone LaTeX conventions](TEX_AUTHORING.md)
across manager and worker reports. Larger text and some matrices still need local scrolling.

The optional **Automatically request a copy when equations stay wide** setting belongs to
this document and starts off disabled. It uses the selected model only after the rendered
equations still overflow, keeping one automatic attempt per source version and model settings
across tabs and reopening. You still choose when to read the copy. Failed attempts do not
repeat automatically; **Create reading copy** explicitly retries. Use **Save automatic model**
to apply changed model settings to future automatic requests. This uses the existing
QUARK-supervised formatter; it is not the separate proposed lightweight scientific repair helper.

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

When a source uses `\bibliography`, Reading includes its supplied same-name `.bbl`
under the same folder and size limits. Bibliography prose and the supported numeric citation
links are retained. Reading keeps its native hyperlink parser instead of expanding the
recognized REVTeX bibliography URL-sanitizer fallback; reference text and URLs stay intact.
Without a `.bbl`, named local `.bib` databases use the same aggregate
limits and sandboxed Pandoc citeproc, with a labelled author–date Reading style and linked
references at the end. Missing or unreadable databases stay explicit. No TeX/BibTeX command,
source-selected CSL file or remote bibliography runs; Original PDF retains publisher styles.
Supplied natbib `Author(Year)` labels with a four-digit
year retain author–year text for `\citet` and `\citep`, including explicit citation notes.
Other author–year styles and non-equation cross-reference numbering still need Original PDF.

An explicitly named local figure may omit its extension. Reading tries the exact name,
then PDF, PNG, JPG, JPEG, WebP and GIF under the same folder and file-size checks. It does
not search folders or infer missing paths; unavailable figures keep an Original PDF note.
Reading also supports one literal, top-level preamble `\graphicspath` declaration with
up to 16 local directories. It checks the source directory first, then the declared order,
using the same extension and file guards. Macro, conditional and scoped path declarations
still need Original PDF.
For a main file in a subfolder, Reading finally tries the exact figure path at the
registered document root. Source-directory and declared graphic-path matches take precedence;
no folder scan or filename guessing runs.
PDF figure conversion shares Reading’s 60-second conversion budget. When time runs out,
the paper’s body, completed figures and raster images remain available; each unconverted
figure keeps its Original PDF note.

Plain preamble `\usepackage` references may supply local `.sty` author macros as data.
Reading restores only unique zero-argument definitions made from scoped font atoms
(such as `\mathrm{opt}`), one Latin atom with a local roman subscript (`d_{\rm IF}`),
or the native `\epsilon` symbol, retaining source/provenance health. Conflicting, conditional,
scoped, recursive and unsupported definitions retain their source/PDF fallback. Styles
are never executed and their package imports are not followed; no model call is made.
An author alias for an unsupported command such as `\Tilde` remains unsupported; Reading
does not replace it with a similarly named accent.

Reading mode interprets LaTeX content, not every package's print layout. Complex package
commands may need Original PDF; missing figures are marked. An ordinary PDF without its
LaTeX source keeps the PDF viewer rather than claiming reliable mathematical reflow.
For a wide display equation with one unambiguous top-level `=`, Reading can place the
unchanged left side above the unchanged `= right side`, at the same font size. It keeps
the original line when it fits. Unsupported or still-wide expressions retain their own
horizontal scroll and direction hint; sources, labels and Original PDF stay unchanged.
Includes outside the registered folder are refused in Reading mode. Inputs are bounded to
100 files / 8 MB combined, conversions to 30 seconds per operation, with one reading build
at a time. Missing conversion tools have a retry action; the original PDF stays available.

Reading starts with the paper's title, authors, affiliations, contact emails, date and
abstract (revtex/aastex `\affiliation`, `\email`, `\correspondingauthor`, amsart `\address`
and JHEP `\abstract{…}` included). A paper is never rejected as a whole. Deterministic
source rules, with no model, read `\global\long\def`, skip preamble `\makeatletter` blocks and
self-referential or expansion-steering definitions, join blank lines inside captions,
footnotes and title arguments, and expand `\be`/`\ee`-style shortcuts without grouping
them. If Pandoc still rejects the source, Reading closes a `{` left open at a paragraph end,
then replaces the rejected passage with “Part of this section is only in the Original PDF.”
Each Pandoc pass is time-limited and the retries are capped. A missing `\input` shows a
note in its place. Plain TeX (harvmac, `\bye`) shows a sentence pointing to Original PDF.
Messages are sentences without paths. The reading result carries an optional `health`
report: missing includes, dropped passages, applied rules and the conversion state. Clients
tolerate older and newer servers.

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
