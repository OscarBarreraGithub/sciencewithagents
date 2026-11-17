# The paper

[Read the PDF](science-with-agents.pdf) · [Edit the LaTeX source](science-with-agents.tex)

A five-page introduction to keeping a coherent research project across AI conversations, with a lab notebook, recoverable responsibilities, and evidence that can accompany a paper. Detailed setup and procedures are in the [guide](../README.md).

To rebuild, use a TeX distribution with pdfLaTeX, geometry, fontenc, lmodern, microtype, TikZ/PGF, hyperref, and titlesec. From this directory run:

```sh
pdflatex -interaction=nonstopmode -halt-on-error science-with-agents.tex
pdflatex -interaction=nonstopmode -halt-on-error science-with-agents.tex
```

The second pass resolves references. Inspect the resulting PDF and confirm the five-page limit. The build uses no external data, shell-escape, or bibliography service. The source contains the figure and references. This reproduces the document; PDF metadata can make byte hashes vary across builds.
