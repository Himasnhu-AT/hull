// The kit's CSS, injected once per document. Everything is a class under .hull-ui and reads the theme variables.
export const CSS = `
.hull-ui{position:absolute;inset:0;pointer-events:none;overflow:hidden;color:var(--hull-text);font:var(--hull-size)/1.35 var(--hull-font)}
.hull-ui *{box-sizing:border-box}
.hull-panel,.hull-stack,.hull-row{position:relative;display:flex;gap:var(--hull-gap,10px)}
.hull-panel{flex-direction:column;background:var(--hull-panel);padding:var(--hull-gutter);border-radius:var(--hull-radius);border:1px solid var(--hull-line)}
.hull-stack{flex-direction:column}
.hull-row{flex-direction:row;align-items:center}
.hull-solid{pointer-events:auto}
.hull-text{margin:0;overflow-wrap:anywhere}
.hull-title{margin:0;font-size:1.6em;font-weight:600;line-height:1.15}
.hull-label{color:var(--hull-muted);text-transform:uppercase;letter-spacing:var(--hull-tracking);font-size:.8em}
.hull-bar{position:relative;height:10px;min-width:80px;background:var(--hull-line);border-radius:var(--hull-radius);overflow:hidden}
.hull-bar>i{display:block;width:100%;height:100%;background:var(--hull-accent);transform-origin:0 50%;transform:scaleX(0)}
.hull-bar.low>i{background:var(--hull-danger)}
.hull-btn{pointer-events:auto;font:inherit;color:var(--hull-text);background:var(--hull-panel);border:1px solid var(--hull-line);border-radius:var(--hull-radius);padding:.6em 1.1em;cursor:pointer;text-align:left}
.hull-btn:hover{border-color:var(--hull-accent)}
.hull-btn:focus-visible{outline:2px solid var(--hull-accent);outline-offset:2px}
.hull-btn.primary{background:var(--hull-accent);color:var(--hull-panel);border-color:transparent;font-weight:600}
.hull-btn:disabled{opacity:.5;cursor:default}
.hull-img{display:block;max-width:100%}
.hull-hidden{display:none!important}
.hull-a{position:absolute;margin:var(--hull-gutter)}
.hull-a-top-left{top:0;left:0}
.hull-a-top{top:0;left:50%;transform:translateX(-50%);margin-left:0;margin-right:0}
.hull-a-top-right{top:0;right:0}
.hull-a-left{top:50%;left:0;transform:translateY(-50%);margin-top:0;margin-bottom:0}
.hull-a-center{top:50%;left:50%;transform:translate(-50%,-50%);margin:0}
.hull-a-right{top:50%;right:0;transform:translateY(-50%);margin-top:0;margin-bottom:0}
.hull-a-bottom-left{bottom:0;left:0}
.hull-a-bottom{bottom:0;left:50%;transform:translateX(-50%);margin-left:0;margin-right:0}
.hull-a-bottom-right{bottom:0;right:0}
@media (prefers-reduced-motion:no-preference){.hull-bar>i{transition:transform .12s linear}}
`;

const done = new WeakSet<Document>();

/** Adds the stylesheet once. Placed first in <head> so a game's own CSS can override it. */
export function injectStyles(doc: Document): void {
  if (done.has(doc)) return;
  done.add(doc);
  const style = doc.createElement('style');
  style.setAttribute('data-hull-ui', '');
  style.textContent = CSS;
  doc.head.insertBefore(style, doc.head.firstChild);
}
