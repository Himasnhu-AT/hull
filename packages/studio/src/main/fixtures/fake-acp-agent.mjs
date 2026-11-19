#!/usr/bin/env node
// A scripted ACP agent for tests and screenshots: no model, no network. On a prompt it checks the project through the
// MCP server it was handed, shows a plan, asks permission to change runSpeed, and (if allowed) changes it through the
// same MCP server, so the change lands in the history under the author the app named. A prompt containing "wait"
// holds until cancelled. A prompt with _meta "hull.mode" (brief, build, fix) is answered the way Hull's own builder answers: streamed
// text, cards in _meta "hull.ui" (ask and approve wait as permission requests), and real writes through the MCP server
// (brief.write, create.set, explain.write, tunables.set), so the app's screens show real data. FAKE_FAIL_STAGE=<stage> makes that
// stage fail once. Not part of a ship build: it lives under fixtures/ and only HULL_ACP_AGENTS points at it.
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const sessions = new Map();
const cancelled = new Set();
let nextId = 1;

async function mcp(server, name, args) {
  const headers = { 'content-type': 'application/json', accept: 'application/json', ...Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value])) };
  const post = (body, extra = {}) => fetch(server.url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-acp-agent', version: '1' } } });
  const session = init.headers.get('mcp-session-id');
  await init.json();
  const r = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, { 'mcp-session-id': session })).json();
  return r.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (server, name, args) => (await mcp(server, name, args))?.structuredContent;

// A 1x1 grey PNG, drawn stretched under the marks of the map drawing.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const STAGES = ['world', 'actors', 'animations', 'rules', 'sounds', 'effects', 'screens'];
const KINDS = { world: ['look', 'material', 'level'], actors: ['character'], animations: ['anim-set', 'anim-graph'], sounds: ['sound'], effects: ['vfx'], screens: ['ui-theme'] };
const briefStarted = new Set();
const failed = new Set();
let fixes = 0;

const EXPLAIN = {
  world: { id: 'island-layout', title: 'Island layout', why: 'The raiders come from the three marked places, so you meet them one at a time.', body: { type: 'map', image: PNG, width: 320, height: 200, marks: [{ x: 0.2, y: 0.3, label: 'Landing beach' }, { x: 0.55, y: 0.6, label: 'Pampas field' }, { x: 0.82, y: 0.25, label: 'Shrine steps' }] } },
  rules: { id: 'raider-turn', title: 'What a raider does', why: 'A raider shows a cut before it swings, then waits to see your answer. This is the loop it follows.', body: { type: 'flow', nodes: [{ id: 'watch', text: 'Watch the player' }, { id: 'near', text: 'Is the player close?', kind: 'ask' }, { id: 'tell', text: 'Raise the blade (the tell)' }, { id: 'cut', text: 'Cut' }, { id: 'rest', text: 'Recover', kind: 'end' }], edges: [{ from: 'watch', to: 'near' }, { from: 'near', to: 'tell', label: 'yes' }, { from: 'near', to: 'watch', label: 'no' }, { from: 'tell', to: 'cut' }, { from: 'cut', to: 'rest' }] } },
  sounds: { id: 'sound-levels', title: 'How loud things are', why: 'Hits are loudest, footsteps quietest, so a fight stays readable.', body: { type: 'table', columns: ['Sound', 'Loudness'], rows: [['Hit', 'loud'], ['Pickup', 'medium'], ['Footstep', 'quiet']] } },
};

async function briefRun(ctx) {
  const { say, ask, hull, sessionId, text } = ctx;
  const stream = async (s) => { for (const w of s.match(/\S+\s*/g) ?? []) { await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: w } }); await sleep(25); } };
  const card = (block) => say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' }, _meta: { 'hull.ui': block } });
  const sections = [
    ['premise', 'You are a swordswoman on a windy island. Raiders land on the beach and you answer their cuts with your blade.'],
    ['what-you-do', 'Walk the island, read each raider before it strikes, deflect, then answer.'],
    ['controls', 'Move with WASD, swing with the mouse, deflect with Space.'],
  ];
  const blockOf = (doc, mark, writing) => ({ id: 'brief', kind: 'brief', title: doc?.title || 'Your game', sections: [...(doc?.sections ?? []), ...(writing && !(doc?.sections ?? []).some((s) => s.id === writing) ? [{ id: writing, title: writing, text: '' }] : [])].map((s) => ({ ...s, status: mark(s.id) })) });
  if (briefStarted.has(sessionId)) {
    // A follow-up: change one section and mark it changed.
    await stream('Done: I moved the first playable to night. ');
    const r = await call(hull, 'brief.write', { section: { id: 'first-playable', text: 'The first playable starts at night on the landing beach, with one raider.' }, author: 'Fake agent' });
    await card(blockOf(r?.doc, (id) => (id === 'first-playable' ? 'changed' : 'done')));
    return;
  }
  briefStarted.add(sessionId);
  await stream('Hello. I will ask one thing and then write your brief. ');
  const who = await ask({ id: 'q-hero', kind: 'ask', question: 'Who do you play?', options: ['A swordswoman', 'A traveller with a spear', 'Something else'] }, ['A swordswoman', 'A traveller with a spear', 'Something else']);
  if (who === null) return; // the person answered in their own words: that text is the next prompt
  await stream('Good. Writing the brief now, one part at a time. ');
  let doc = null;
  for (const [i, [id, body]] of sections.entries()) {
    await card(blockOf(doc, (sid) => (sid === id ? 'writing' : 'done'), id));
    await sleep(250);
    const r = await call(hull, 'brief.write', { section: { id, text: i === 0 ? body.replace('swordswoman', who.toLowerCase().replace(/^an? /, '')) : body }, author: 'Fake agent' });
    doc = r?.doc ?? doc;
    await card(blockOf(doc, () => 'done'));
  }
  const ok = await ask({ id: 'approve', kind: 'approve', question: 'Does this brief look right?', yes: 'Looks right, build it', no: 'I want to change something' }, null);
  if (ok === 'yes') {
    await call(hull, 'create.set', { patch: { briefApproved: true, step: 'build' }, author: 'Fake agent' });
    await stream('Approved. Starting the build.');
  } else if (ok === 'no') await stream('Tell me what to change and I will edit the brief.');
}

async function buildRun(ctx) {
  const { say, hull, stage: only } = ctx;
  const card = (block) => say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' }, _meta: { 'hull.ui': block } });
  const listed = await call(hull, 'library.list', {});
  const items = Array.isArray(listed) ? listed : (listed?.items ?? []);
  await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Building one stage at a time. ' } });
  for (const id of only ? [only] : STAGES) {
    let st = await call(hull, 'create.set', { stage: { id, status: 'building' }, author: 'Fake agent' });
    await card({ id: 'stages', kind: 'stages', stages: st.stages });
    await sleep(500);
    if (process.env.FAKE_FAIL_STAGE === id && !failed.has(id)) {
      failed.add(id);
      st = await call(hull, 'create.set', { stage: { id, status: 'failed', summary: 'The type check failed in src/effects.ts:12:3. Trying this stage again should fix it.' }, author: 'Fake agent' });
      await card({ id: 'stages', kind: 'stages', stages: st.stages });
      continue;
    }
    const keys = items.filter((i) => (KINDS[id] ?? []).includes(i.kind)).slice(0, 3).map((i) => i.id);
    const ex = EXPLAIN[id];
    if (ex) { await call(hull, 'explain.write', { doc: { ...ex, stage: id }, author: 'Fake agent' }); keys.push('explain:' + ex.id); }
    st = await call(hull, 'create.set', { stage: { id, status: 'ready', summary: 'Made ' + (keys.length || 'no') + ' piece(s) for ' + id + '.', pieces: keys }, author: 'Fake agent' });
    await card({ id: 'stages', kind: 'stages', stages: st.stages });
    await card({ id: 'pieces-' + id, kind: 'pieces', stage: id, keys });
    if (ex) await card({ id: 'explain-' + ex.id, kind: 'explain', doc: { ...ex, stage: id } });
  }
  await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'That stage is done.' } });
}

async function fixRun(ctx) {
  const { say, hull, text, params } = ctx;
  const card = (block) => say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' }, _meta: { 'hull.ui': block } });
  const seen = params.prompt.some((b) => b.type === 'image') ? 'I can see the frozen picture. ' : '';
  await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: seen + 'Looking at it. ' } });
  await say({ sessionUpdate: 'tool_call', toolCallId: 'f' + fixes, title: 'Set player.runSpeed', kind: 'edit', status: 'in_progress' });
  const speeds = [6, 9, 7, 11];
  const from = speeds[fixes % speeds.length], to = speeds[(fixes + 1) % speeds.length];
  fixes++;
  await call(hull, 'tunables.set', { block: 'player', key: 'runSpeed', value: to, author: 'Fake agent' });
  await say({ sessionUpdate: 'tool_call_update', toolCallId: 'f' + (fixes - 1), status: 'completed' });
  const h = await call(hull, 'history.list', { limit: 1 });
  await card({ id: 'change-' + fixes, kind: 'change', title: 'Run speed changed', piece: 'Player numbers', lines: [{ label: 'Run speed', from: String(from), to: String(to) }], ...(h?.items?.[0]?.id ? { change: h.items[0].id } : {}) });
  await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I changed the run speed.' } });
}

const app = agent({ name: 'fake-acp-agent' })
  .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { mcpCapabilities: { http: true, sse: false } }, agentInfo: { name: 'fake-acp-agent', version: '1.0.0' } }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    const sessionId = `fake-${process.pid}-${nextId++}`;
    sessions.set(sessionId, params.mcpServers);
    return { sessionId };
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => { cancelled.add(params.sessionId); })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const sessionId = params.sessionId;
    const servers = sessions.get(sessionId) ?? [];
    const hull = servers.find((s) => s.name === 'hull');
    const say = (update) => client.notify(methods.client.session.update, { sessionId, update });
    const text = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
    const plan = (a, b, c) => say({ sessionUpdate: 'plan', entries: [
      { content: 'Check the project', status: a, priority: 'high' },
      { content: 'Raise the run speed', status: b, priority: 'high' },
      { content: 'Check again', status: c, priority: 'medium' },
    ] });
    cancelled.delete(sessionId);
    const mode = params._meta?.['hull.mode'];
    if (mode) {
      // Asks a waiting card: resolves to the chosen choice (ask) or 'yes' / 'no' (approve), null when the person answered in words.
      const askCard = async (block, choices) => {
        const options = block.kind === 'ask'
          ? choices.map((c, i) => ({ optionId: String(i), name: c, kind: 'allow_once' }))
          : [{ optionId: 'yes', name: block.yes, kind: 'allow_once' }, { optionId: 'no', name: block.no, kind: 'reject_once' }];
        const r = await client.request(methods.client.session.requestPermission, { sessionId, toolCall: { toolCallId: block.id, title: block.question, kind: 'other', status: 'pending', _meta: { 'hull.ui': block } }, options });
        if (r.outcome.outcome !== 'selected') return null;
        return block.kind === 'ask' ? choices[Number(r.outcome.optionId)] : r.outcome.optionId;
      };
      const ctx = { say, hull, text, params, sessionId, stage: params._meta?.['hull.stage'], ask: askCard };
      if (!hull) return { stopReason: 'end_turn' };
      if (mode === 'brief') await briefRun(ctx); else if (mode === 'build') await buildRun(ctx); else await fixRun(ctx);
      return { stopReason: cancelled.has(sessionId) ? 'cancelled' : 'end_turn' };
    }
    await plan('in_progress', 'pending', 'pending');
    await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking the project first. ' } });
    await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `I was handed ${servers.length} tool server(s).` } });
    if (/wait/.test(text)) { for (let i = 0; i < 200 && !cancelled.has(sessionId); i++) await sleep(50); return { stopReason: cancelled.has(sessionId) ? 'cancelled' : 'end_turn' }; }
    await say({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'check', kind: 'read', status: 'in_progress' });
    const checked = hull ? await mcp(hull, 'check', {}) : { isError: true, content: [{ type: 'text', text: 'no tool server' }] };
    await say({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: checked.isError ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: checked.isError ? 'check failed' : 'check: no problems' } }] });
    await plan('completed', 'in_progress', 'pending');
    const asked = await client.request(methods.client.session.requestPermission, {
      sessionId,
      toolCall: { toolCallId: 'c2', title: 'Set player.runSpeed to 9', kind: 'edit', status: 'pending', content: [{ type: 'diff', path: 'config/tuning/player.json', oldText: '{\n  "runSpeed": 6\n}', newText: '{\n  "runSpeed": 9\n}' }] },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Reject', kind: 'reject_once' }],
    });
    if (asked.outcome.outcome !== 'selected' || asked.outcome.optionId !== 'allow') {
      await plan('completed', 'pending', 'pending');
      await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Understood, I will leave the speed as it is.' } });
      return { stopReason: asked.outcome.outcome === 'cancelled' && cancelled.has(sessionId) ? 'cancelled' : 'end_turn' };
    }
    await say({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'Set player.runSpeed to 9', kind: 'edit', status: 'in_progress' });
    const set = hull ? await mcp(hull, 'tunables.set', { block: 'player', key: 'runSpeed', value: 9 }) : { isError: true, content: [] };
    await say({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: set.isError ? 'failed' : 'completed', content: [{ type: 'diff', path: 'config/tuning/player.json', oldText: '{\n  "runSpeed": 6\n}', newText: '{\n  "runSpeed": 9\n}' }] });
    await plan('completed', 'completed', 'in_progress');
    const again = hull ? await mcp(hull, 'check', {}) : { isError: true };
    await plan('completed', 'completed', again.isError ? 'pending' : 'completed');
    await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Done: run speed is 9 and the project checks clean.' } });
    return { stopReason: 'end_turn' };
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
