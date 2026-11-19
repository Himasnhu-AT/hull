// The drawing of an explain document: a flow as SVG (laid out by explainLayout.ts), a map as its picture with numbered marks and a
// legend, a table, or a picture.

import { useMemo, type JSX } from 'react';
import type { ExplainBody } from 'hull/dev/protocol';
import { layoutFlow, NODE_H } from './explainLayout.ts';

const isImage = (s: string): boolean => /^data:image\/(png|jpeg|webp|gif);base64,/.test(s);

function Flow({ body, uid }: { body: Extract<ExplainBody, { type: 'flow' }>; uid: string }): JSX.Element {
  const f = useMemo(() => layoutFlow(body), [body]);
  const marker = `ah-${uid}`;
  return (
    <svg className="cr-flow" viewBox={`0 0 ${f.width} ${f.height}`} role="img" aria-label={`Flowchart: ${body.nodes.map((n) => n.text).join(', then ')}`} style={{ minWidth: Math.min(f.width, 720) }}>
      <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" className="ah" /></marker></defs>
      {f.edges.map((e, i) => (
        <g key={i}>
          <path d={e.d} fill="none" className="edge" markerEnd={`url(#${marker})`} />
          {e.label && <text className="lbl" x={e.lx} y={e.ly} textAnchor="middle">{e.label}</text>}
        </g>
      ))}
      {f.nodes.map((n) => (
        <g key={n.id} className={n.kind}>
          <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={9} />
          {n.lines.map((l, i) => <text key={i} x={n.x + n.w / 2} y={n.y + NODE_H / 2 + (i - (n.lines.length - 1) / 2) * 14 + 4} textAnchor="middle">{l}</text>)}
        </g>
      ))}
    </svg>
  );
}

export function ExplainDrawing({ body, uid }: { body: ExplainBody; uid: string }): JSX.Element {
  switch (body.type) {
    case 'flow': return <Flow body={body} uid={uid} />;
    case 'map':
      return (
        <div className="cr-map">
          <div className="cr-map-pic" style={{ aspectRatio: `${body.width} / ${body.height}` }}>
            {isImage(body.image) ? <img src={body.image} alt="" /> : <span className="cr-sub">The picture could not be shown.</span>}
            {body.marks.map((m, i) => <span key={i} className="cr-mark" style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }} aria-hidden="true">{i + 1}</span>)}
          </div>
          <ol className="cr-legend">{body.marks.map((m, i) => <li key={i}><span className="cr-mark inline" aria-hidden="true">{i + 1}</span>{m.label}</li>)}</ol>
        </div>
      );
    case 'table':
      return (
        <div className="cr-tbl"><table>
          <thead><tr>{body.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{body.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody>
        </table></div>
      );
    case 'image':
      return isImage(body.image) ? <img className="cr-xfig-img" src={body.image} alt="" style={{ aspectRatio: `${body.width} / ${body.height}` }} /> : <span className="cr-sub">The picture could not be shown.</span>;
  }
}
