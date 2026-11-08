// Library-wide scheduling summaries, rendered only from the backend snapshot.
const states = [['new', 'New'], ['learning', 'Learning'], ['review', 'Review'], ['relearning', 'Relearning']];
const svgNamespace = 'http://www.w3.org/2000/svg';
const count = value => Number.isFinite(value) && value > 0 ? value : 0;
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svgElement(tag, attributes = {}, text) {
  const node = document.createElementNS(svgNamespace, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function dateLabels(day) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!parts) return { weekday: '', date: day || '', full: day || '' };
  // Day keys are civil dates, not UTC timestamps. Local noon also avoids DST gaps.
  const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 12);
  return {
    weekday: date.toLocaleDateString(undefined, { weekday: 'short' }),
    date: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    full: date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
  };
}

export function mountDashboard({ container, signal }) {
  const root = element('section', 'fc-dashboard'); root.setAttribute('aria-label', 'Spaced repetition');
  const heading = element('h2', 'fc-dashboard-heading', 'Spaced repetition');
  const loading = element('p', 'fc-muted', 'Loading statistics…'); loading.setAttribute('role', 'status');
  const stateTitle = element('h3', '', 'Current states');
  const stateBar = element('div', 'fc-state-bar'); stateBar.setAttribute('aria-hidden', 'true');
  const legend = element('ul', 'fc-state-legend');
  const stateCaption = element('p', 'fc-chart-caption', 'Active propositions with at least one cue.');
  const charts = element('div', 'fc-chart-grid');
  root.append(heading, loading, stateTitle, stateBar, legend, stateCaption, charts);
  const stateNodes = states.map(([key, label]) => {
    const segment = element('span', 'fc-state-segment'); segment.dataset.state = key; stateBar.append(segment);
    const item = element('li'); item.dataset.state = key;
    const name = element('span', '', label), value = element('strong', '', '0');
    item.append(name, document.createTextNode(' '), value); legend.append(item);
    return { key, label, segment, value };
  });
  function chart(kind, title, caption) {
    const figure = element('figure', 'fc-chart'), chartTitle = element('h3', '', title);
    figure.dataset.chart = kind;
    const scroll = element('div', 'fc-chart-scroll');
    const svg = svgElement('svg', { class: 'fc-chart-svg', role: 'img', width: '100%', preserveAspectRatio: 'xMidYMid meet' });
    scroll.append(svg); figure.append(chartTitle, scroll, element('figcaption', 'fc-chart-caption', caption)); charts.append(figure);
    return { title, svg };
  }
  const due = chart('due', 'Scheduled due', 'Current scheduled due dates.');
  const activity = chart('activity', 'Scheduled reviews', 'Scheduled review ratings recorded each day.');
  let disposed = false;
  function renderChart(chart, values, kind, width) {
    const rows = Array.isArray(values) ? values : [];
    const step = width / Math.max(rows.length, 1), baseline = 130;
    const maximum = Math.max(1, ...rows.map(row => count(row.count)));
    chart.svg.replaceChildren(); chart.svg.setAttribute('viewBox', `0 0 ${width} 184`);
    const descriptions = [];
    for (const [index, row] of rows.entries()) {
      const labels = dateLabels(row.day);
      const special = kind === 'due' && row.day === null ? 'Overdue' : (kind === 'due' && index === 1) || (kind === 'activity' && index === rows.length - 1) ? 'Today' : '';
      const label = special || (kind === 'due' ? labels.weekday : labels.date);
      const detail = special || labels.full, value = count(row.count);
      descriptions.push(`${detail}: ${value}`);
      const group = svgElement('g', { 'data-day': row.day ?? 'overdue' });
      const x = step * (index + .5), height = Math.max(1, value / maximum * 104);
      const bucket = kind === 'activity' ? 'activity' : special === 'Overdue' ? 'overdue' : special === 'Today' ? 'today' : 'future';
      // Palette hooks belong to bars, never their groups or foreground labels.
      group.append(svgElement('rect', { class: 'fc-chart-bar', 'data-bucket': bucket, x: x - step * .3, y: baseline - height, width: step * .6, height, fill: 'currentColor', opacity: '.6', rx: 2 }));
      group.append(svgElement('text', { class: 'fc-chart-count', x, y: baseline - height - 6, 'text-anchor': 'middle', 'font-size': 12, fill: 'currentColor' }, String(value)));
      const dateText = svgElement('text', { class: 'fc-chart-label', x, y: 151, 'text-anchor': 'middle', 'font-size': 10, fill: 'currentColor' });
      dateText.append(svgElement('tspan', { x }, label));
      if (kind === 'due' && !special) dateText.append(svgElement('tspan', { class: 'fc-chart-date', x, dy: 15 }, labels.date));
      group.append(dateText); chart.svg.append(group);
    }
    const accessible = `${chart.title}: ${descriptions.length ? descriptions.join('; ') : 'No data available.'}`;
    chart.svg.setAttribute('aria-label', accessible);
  }
  function update(statistics) {
    if (disposed || signal.aborted) return;
    loading.hidden = statistics != null;
    const total = states.reduce((sum, [key]) => sum + count(statistics?.states?.[key]), 0);
    for (const node of stateNodes) {
      const value = count(statistics?.states?.[node.key]);
      node.value.textContent = String(value); node.segment.style.width = `${total ? value / total * 100 : 0}%`;
      node.segment.title = `${node.label}: ${value}`;
    }
    // Equal-width cards must share SVG proportions so baselines and captions align.
    const width = Math.max(320, Array.isArray(statistics?.due) ? statistics.due.length * 64 : 0, Array.isArray(statistics?.activity) ? statistics.activity.length * 48 : 0);
    renderChart(due, statistics?.due, 'due', width); renderChart(activity, statistics?.activity, 'activity', width);
  }
  function dispose() {
    if (disposed) return;
    disposed = true; signal.removeEventListener('abort', dispose); root.remove();
  }
  if (signal.aborted) dispose();
  else { container.append(root); signal.addEventListener('abort', dispose, { once: true }); update(); }
  return { update, dispose };
}
