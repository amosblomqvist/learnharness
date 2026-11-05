const assert = require('node:assert/strict');
const test = require('node:test');
const { parseHTML } = require('linkedom');

async function setup({ aborted = false } = {}) {
  const { document } = parseHTML('<html><body><main><p id="existing">Keep me</p></main><aside>Outside</aside></body></html>');
  global.document = document;
  const { mountDashboard } = await import('../src/dashboard.js');
  const container = document.querySelector('main'), controller = new AbortController();
  if (aborted) controller.abort();
  const dashboard = mountDashboard({ container, signal: controller.signal });
  return { document, container, controller, dashboard, get root() { return container.querySelector('.fc-dashboard'); } };
}
function dayAt(offset) {
  const day = new Date(2026, 10, 5 + offset, 12);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}
function statistics() {
  return {
    states: { new: 2, learning: 3, review: 4, relearning: 1 },
    due: [{ day: null, count: 2 }, ...Array.from({ length: 8 }, (_, index) => ({ day: dayAt(index), count: index % 4 }))],
    activity: Array.from({ length: 14 }, (_, index) => ({ day: dayAt(index - 13), count: index % 3 })),
  };
}
const charts = h => [...h.root.querySelectorAll('.fc-chart-svg')];
const groups = svg => [...svg.querySelectorAll('g')];
const visibleCounts = svg => groups(svg).map(group => Number(group.querySelector('text').textContent));

test('library-wide dashboard shows labeled current-state counts and neutral chart captions', async () => {
  const h = await setup();
  try {
    h.dashboard.update(statistics());
    assert.equal(h.root.tagName, 'SECTION');
    assert.equal(h.root.getAttribute('aria-label'), 'Spaced repetition');
    assert.equal(h.root.querySelector('h2.fc-dashboard-heading').textContent, 'Spaced repetition');
    assert.deepEqual([...h.root.querySelectorAll('.fc-state-legend li')].map(node => node.textContent), ['New 2', 'Learning 3', 'Review 4', 'Relearning 1']);
    const segments = [...h.root.querySelectorAll('.fc-state-segment')];
    assert.deepEqual(segments.map(node => node.dataset.state), ['new', 'learning', 'review', 'relearning']);
    assert.deepEqual(segments.map(node => node.style.width), ['20%', '30%', '40%', '10%']);
    assert.equal(h.root.querySelector('.fc-state-bar').getAttribute('aria-hidden'), 'true');
    assert.ok(h.root.textContent.includes('Active propositions with at least one cue.'));
    assert.deepEqual([...h.root.querySelectorAll('.fc-chart h3')].map(node => node.textContent), ['Scheduled due', 'Scheduled reviews']);
    assert.equal(h.root.querySelectorAll('.fc-chart-grid > .fc-chart').length, 2);
    assert.match(h.root.textContent, /Current scheduled due dates, not a forecast of future workload or repeat reviews\./);
    assert.match(h.root.textContent, /Scheduled-review ratings recorded each day, not unique propositions\./);
    assert.equal(h.root.querySelector('button, input, select, a'), null, 'dashboard has no filters or actions');
  } finally { h.dashboard.dispose(); }
});

test('nine due bars and fourteen activity bars expose visible counts, hover titles and accessible image summaries', async () => {
  const h = await setup();
  try {
    const data = statistics(); h.dashboard.update(data);
    const [due, activity] = charts(h);
    assert.equal(groups(due).length, 9); assert.equal(groups(activity).length, 14);
    assert.deepEqual(visibleCounts(due), data.due.map(row => row.count));
    assert.deepEqual(visibleCounts(activity), data.activity.map(row => row.count));
    assert.equal(groups(due)[0].querySelector('tspan').textContent, 'Overdue');
    assert.equal(groups(due)[1].querySelector('tspan').textContent, 'Today');
    assert.equal(groups(activity).at(-1).querySelector('tspan').textContent, 'Today');
    for (const [svg, rows, title] of [[due, data.due, 'Scheduled due'], [activity, data.activity, 'Scheduled reviews']]) {
      assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
      assert.equal(svg.getAttribute('role'), 'img');
      assert.ok(svg.getAttribute('aria-label').startsWith(`${title}: `));
      assert.equal(svg.querySelector('title').textContent, svg.getAttribute('aria-label'));
      assert.ok(svg.hasAttribute('viewBox')); assert.equal(svg.getAttribute('width'), '100%');
      assert.equal(svg.parentElement.className, 'fc-chart-scroll');
      groups(svg).forEach((group, index) => {
        const description = group.querySelector('title').textContent;
        assert.ok(description.endsWith(`: ${rows[index].count}`));
        assert.ok(svg.getAttribute('aria-label').includes(description), 'image summary includes every bar label and count');
        assert.equal(group.getAttribute('data-day'), rows[index].day ?? 'overdue');
        const rect = group.querySelector('rect');
        assert.equal(rect.getAttribute('fill'), 'currentColor');
        assert.ok(Number(rect.getAttribute('height')) >= 0);
        assert.ok(Number(rect.getAttribute('y')) >= 0);
      });
    }
  } finally { h.dashboard.dispose(); }
});

test('palette hooks target only bars and state segments; only future due dates expose the secondary-date dimming hook', async () => {
  const h = await setup();
  try {
    h.dashboard.update(statistics());
    const figures = [...h.root.querySelectorAll('.fc-chart')];
    assert.deepEqual(figures.map(figure => figure.dataset.chart), ['due', 'activity']);
    // Parent CSS maps new/learning/review/relearning to blue/amber/green/red.
    const stateKeys = ['new', 'learning', 'review', 'relearning'];
    assert.deepEqual([...h.root.querySelectorAll('.fc-state-segment')].map(node => node.dataset.state), stateKeys);
    assert.deepEqual([...h.root.querySelectorAll('.fc-state-legend li')].map(node => node.dataset.state), stateKeys);
    const [due, activity] = charts(h);
    assert.deepEqual([...due.querySelectorAll('.fc-chart-bar')].map(bar => bar.getAttribute('data-bucket')), ['overdue', 'today', ...Array(7).fill('future')]);
    assert.deepEqual([...activity.querySelectorAll('.fc-chart-bar')].map(bar => bar.getAttribute('data-bucket')), Array(14).fill('activity'));
    // Parent CSS maps overdue/today/future/activity to red/amber/blue/green.
    for (const svg of [due, activity]) {
      assert.equal(svg.querySelectorAll('[data-bucket]').length, groups(svg).length);
      assert.ok([...svg.querySelectorAll('[data-bucket]')].every(node => node.localName === 'rect'));
      for (const group of groups(svg)) {
        assert.equal(group.hasAttribute('data-bucket'), false);
        assert.equal(group.getAttribute('color'), null); assert.equal(group.getAttribute('opacity'), null);
        const bar = group.querySelector('.fc-chart-bar'); assert.equal(bar.getAttribute('fill'), 'currentColor');
        const count = group.querySelector('.fc-chart-count'), label = group.querySelector('.fc-chart-label');
        for (const text of [count, label]) {
          assert.ok(text); assert.equal(text.getAttribute('fill'), 'currentColor');
          assert.equal(text.closest('[data-bucket]'), null); assert.equal(text.getAttribute('opacity'), null);
          assert.equal(text.classList.contains('fc-chart-date'), false);
        }
        assert.equal(label.querySelector('tspan').classList.contains('fc-chart-date'), false, 'primary weekday/special label stays foreground');
      }
    }
    assert.equal(due.querySelectorAll('.fc-chart-date').length, 7);
    for (const [index, group] of groups(due).entries()) {
      const spans = [...group.querySelectorAll('.fc-chart-label > tspan')];
      assert.equal(spans.length, index < 2 ? 1 : 2);
      if (index < 2) assert.equal(group.querySelector('.fc-chart-date'), null, 'Overdue and Today still omit dates');
      else {
        assert.equal(spans[1].getAttribute('class'), 'fc-chart-date');
        assert.equal(spans[1].getAttribute('dy'), '15');
        assert.ok(spans[1].textContent);
      }
    }
    assert.equal(activity.querySelector('.fc-chart-date'), null, 'activity date labels are not dimmed');
    assert.equal(groups(activity).at(-1).querySelector('tspan').textContent, 'Today');
    h.dashboard.update(statistics());
    assert.deepEqual(charts(h).map(svg => svg.querySelectorAll('.fc-chart-bar').length), [9, 14]);
    assert.deepEqual(charts(h).map(svg => svg.querySelectorAll('.fc-chart-date').length), [7, 0]);
  } finally { h.dashboard.dispose(); }
});

test('updates reuse the owned root and heading, replace chart data and leave snapshot and surrounding DOM untouched', async () => {
  const h = await setup();
  try {
    const root = h.root, heading = root.querySelector('h2'), original = h.document.querySelector('#existing');
    const data = statistics(), serialized = JSON.stringify(data); h.dashboard.update(data);
    assert.equal(JSON.stringify(data), serialized, 'rendering does not mutate the snapshot');
    const changed = statistics(); changed.states.review = 12; changed.due[0].count = 7; changed.activity[0].count = 8;
    h.dashboard.update(changed);
    assert.equal(h.root, root); assert.equal(root.querySelector('h2'), heading);
    assert.equal(h.container.querySelectorAll('.fc-dashboard').length, 1);
    assert.equal(root.querySelector('.fc-state-legend [data-state=review]').textContent, 'Review 12');
    const [due, activity] = charts(h);
    assert.equal(groups(due).length, 9); assert.equal(visibleCounts(due)[0], 7);
    assert.equal(groups(activity).length, 14); assert.equal(visibleCounts(activity)[0], 8);
    assert.equal(h.document.querySelector('#existing'), original); assert.equal(original.textContent, 'Keep me');
    assert.equal(h.document.querySelector('aside').textContent, 'Outside');
  } finally { h.dashboard.dispose(); }
});

test('missing statistics show a loading state without invented dates or counts; explicit empty and zero data stay valid', async () => {
  const h = await setup();
  try {
    assert.equal(h.root.querySelector('[role=status]').hidden, false);
    assert.match(h.root.querySelector('[role=status]').textContent, /Loading/);
    assert.deepEqual(charts(h).map(svg => groups(svg).length), [0, 0]);
    assert.deepEqual([...h.root.querySelectorAll('.fc-state-legend strong')].map(node => node.textContent), ['0', '0', '0', '0']);
    h.dashboard.update({});
    assert.equal(h.root.querySelector('[role=status]').hidden, true);
    assert.deepEqual(charts(h).map(svg => groups(svg).length), [0, 0]);
    const zero = statistics();
    for (const key of Object.keys(zero.states)) zero.states[key] = 0;
    for (const row of [...zero.due, ...zero.activity]) row.count = 0;
    h.dashboard.update(zero);
    assert.deepEqual(charts(h).map(svg => groups(svg).length), [9, 14]);
    for (const svg of charts(h)) {
      assert.ok(groups(svg).every(group => group.querySelector('text').textContent === '0'));
      assert.ok([...svg.querySelectorAll('rect')].every(rect => Number(rect.getAttribute('height')) === 0));
      assert.equal(/NaN|Infinity|undefined/.test(svg.outerHTML), false);
    }
    assert.ok([...h.root.querySelectorAll('.fc-state-segment')].every(node => node.style.width === '0%'));
    h.dashboard.update(null); assert.equal(h.root.querySelector('[role=status]').hidden, false);
    assert.deepEqual(charts(h).map(svg => groups(svg).length), [0, 0]);
  } finally { h.dashboard.dispose(); }
});

test('civil day labels use client locale and local noon without UTC date shifts in western and eastern timezones', async () => {
  const previousTZ = process.env.TZ;
  try {
    for (const timezone of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = timezone;
      const h = await setup();
      try {
        h.dashboard.update(statistics());
        const [due, activity] = charts(h), localDate = new Date(2026, 10, 6, 12);
        const nextDay = groups(due)[2];
        assert.equal(nextDay.querySelectorAll('tspan')[0].textContent, localDate.toLocaleDateString(undefined, { weekday: 'short' }));
        assert.equal(nextDay.querySelectorAll('tspan')[1].textContent, localDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
        const oldestDay = new Date(2026, 9, 23, 12);
        assert.equal(groups(activity)[0].querySelector('tspan').textContent, oldestDay.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
      } finally { h.dashboard.dispose(); }
    }
  } finally { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; }
});

test('abort and explicit disposal are idempotent, remove only owned DOM and make later updates inert', async () => {
  for (const end of ['abort', 'dispose']) {
    const h = await setup(); h.dashboard.update(statistics()); const root = h.root;
    if (end === 'abort') h.controller.abort(); else h.dashboard.dispose();
    h.dashboard.dispose(); h.controller.abort(); h.dashboard.update(statistics());
    assert.equal(h.root, null); assert.equal(root.isConnected, false);
    assert.equal(h.container.textContent, 'Keep me'); assert.equal(h.document.querySelector('aside').textContent, 'Outside');
  }
  const h = await setup({ aborted: true }); h.dashboard.update(statistics()); h.dashboard.dispose();
  assert.equal(h.root, null); assert.equal(h.container.textContent, 'Keep me');
});
