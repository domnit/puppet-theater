// The plain HTML pages the server renders itself: signup and the temporary
// index. Same warm-neutral, flat, playbill spirit as the viewer (spec §5.5) —
// bone paper, near-black ink, one ochre rule, a serif with a point of view.
// No framework, no build step, no gradients.

const CSS = `
  :root {
    --paper: #f2ece1; --ink: #1a1512; --faint: #6b5f52; --rule: #c9bda9;
    --ochre: #a8641b; --oxblood: #6e2a22;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 3rem 1.5rem 5rem; background: var(--paper); color: var(--ink);
    font: 17px/1.55 "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
  }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: 0.01em; margin: 0 0 0.2rem; }
  h2 { font-size: 1rem; font-weight: 600; margin: 2rem 0 0.4rem; }
  .sub { color: var(--faint); font-style: italic; margin: 0 0 1.6rem; }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 1.6rem 0; }
  a { color: var(--oxblood); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 0.45rem 0; border-bottom: 1px solid var(--rule); }
  li .meta { color: var(--faint); font-size: 0.85em; }
  label { display: block; margin: 0 0 0.3rem; }
  input[type=text] {
    font: inherit; padding: 0.4rem 0.5rem; width: 100%; max-width: 18rem;
    background: #fbf8f2; border: 1px solid var(--rule); color: inherit;
  }
  button {
    font: inherit; margin-top: 1rem; padding: 0.4rem 1.1rem; cursor: pointer;
    background: var(--ink); color: var(--paper); border: 0;
  }
  pre {
    background: #e8e0d1; border-left: 3px solid var(--ochre); padding: 0.7rem 0.9rem;
    overflow-x: auto; font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
  }
  code { font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
  .warn { color: var(--oxblood); }
  footer { margin-top: 3rem; color: var(--faint); font-size: 0.85em; }
`;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style>
</head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
