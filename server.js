const { createApp } = require('./mini-http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const app = createApp();
const PORT = parseInt(process.env.POMO_PORT) || 9876;
const DATA_DIR = process.env.POMO_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

app.static('', path.join(__dirname, 'public'));
app.static('/vendor/gridstack', path.join(__dirname, 'node_modules/gridstack/dist'));
for (const [route, pkg] of [['anton', 'anton'], ['playfair', 'playfair-display'], ['elite', 'special-elite'], ['marker', 'permanent-marker']]) {
  app.static('/fonts/' + route, path.join(__dirname, 'node_modules/@fontsource', pkg, 'files'));
}
const COLLAGE_DIR = path.join(__dirname, 'public', 'collage');
fs.mkdirSync(COLLAGE_DIR, { recursive: true });
app.get('/api/collage', (_, res) => {
  let files = [];
  try {
    files = fs.readdirSync(COLLAGE_DIR).filter(f => /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(f) && fs.statSync(path.join(COLLAGE_DIR, f)).size <= 600 * 1024);
  } catch {}
  res.json(files.map(f => '/collage/' + encodeURIComponent(f)));
});

const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SCRATCH_FILE = path.join(DATA_DIR, 'scratchpad.txt');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const KV_FILE = path.join(DATA_DIR, 'kv.json');

const DEFAULT_SETTINGS = {
  work: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4,
  autoStart: false, noise: true, noiseType: 'stream', noiseVolume: 0.15, noiseDuringBreaks: false, chime: true,
  theme: 'newsprint', lite: false,
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function writeJson(file, data) { atomicWrite(file, JSON.stringify(data)); }

// ── Tasks (two lists: work + personal) ──
const LISTS = ['work', 'personal'];
const loadTasks = () => readJson(TASKS_FILE, []).map(t => ({ ...t, list: t.list === 'personal' ? 'personal' : 'work' }));
const saveTasks = tasks => { writeJson(TASKS_FILE, tasks); return tasks; };

app.get('/api/tasks', (_, res) => res.json(loadTasks()));

app.post('/api/tasks', (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  const list = LISTS.includes(req.body.list) ? req.body.list : 'work';
  const tasks = loadTasks();
  let id = Date.now();
  while (tasks.some(t => t.id === id)) id++;
  if (text) tasks.push({ id, text, done: false, list });
  res.json(saveTasks(tasks));
});

app.put('/api/tasks/:id', (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  const tasks = loadTasks();
  const t = tasks.find(t => t.id === parseInt(req.params.id));
  if (t && text) t.text = text;
  res.json(saveTasks(tasks));
});

app.post('/api/tasks/reorder', (req, res) => {
  const lists = req.body.lists || {};
  const tasks = loadTasks();
  const rank = new Map();
  for (const list of LISTS) {
    (Array.isArray(lists[list]) ? lists[list] : []).forEach((rawId, i) => {
      const id = Number(rawId);
      rank.set(id, i);
      const t = tasks.find(t => t.id === id);
      if (t) t.list = list;
    });
  }
  const r = t => (rank.has(t.id) ? rank.get(t.id) : 1e9);
  tasks.sort((a, b) => (a.list === b.list ? 0 : a.list === 'work' ? -1 : 1) || r(a) - r(b));
  res.json(saveTasks(tasks));
});

app.patch('/api/tasks/:id', (req, res) => {
  const tasks = loadTasks();
  const t = tasks.find(t => t.id === parseInt(req.params.id));
  if (t) t.done = !t.done;
  res.json(saveTasks(tasks));
});

app.delete('/api/tasks/:id', (req, res) => {
  res.json(saveTasks(loadTasks().filter(t => t.id !== parseInt(req.params.id))));
});

app.delete('/api/tasks', (req, res) => {
  const list = LISTS.includes(req.query.list) ? req.query.list : null;
  res.json(saveTasks(loadTasks().filter(t => !(t.done && (!list || t.list === list)))));
});

// ── Scratchpad ──
app.get('/api/scratch', (_, res) => {
  try { res.json({ text: fs.readFileSync(SCRATCH_FILE, 'utf8') }); } catch { res.json({ text: '' }); }
});

app.put('/api/scratch', (req, res) => {
  atomicWrite(SCRATCH_FILE, String(req.body.text || ''));
  res.json({ ok: true });
});

// ── Settings ──
app.get('/api/settings', (_, res) => {
  res.json({ ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) });
});

app.put('/api/settings', (req, res) => {
  const merged = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in req.body) merged[k] = req.body[k];
  merged.noiseType = String(merged.noiseType).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'stream';
  merged.theme = String(merged.theme).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'newsprint';
  merged.lite = !!merged.lite;
  writeJson(SETTINGS_FILE, merged);
  res.json(merged);
});

// ── Key-value store (layout, daily stats, iframe url) ──
app.get('/api/kv/:key', (req, res) => {
  res.json({ value: readJson(KV_FILE, {})[req.params.key] ?? null });
});

app.put('/api/kv/:key', (req, res) => {
  const kv = readJson(KV_FILE, {});
  kv[req.params.key] = req.body.value;
  writeJson(KV_FILE, kv);
  res.json({ ok: true });
});

// ── PC stats ──
let lastCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i] || c;
    for (const k of Object.keys(c.times)) {
      const d = c.times[k] - (p.times[k] || 0);
      total += d;
      if (k === 'idle') idle += d;
    }
  });
  lastCpu = now;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

function readTemp() {
  try {
    const zones = fs.readdirSync('/sys/class/thermal').filter(z => z.startsWith('thermal_zone'));
    const temps = zones.map(z => parseInt(fs.readFileSync(`/sys/class/thermal/${z}/temp`, 'utf8')) / 1000)
      .filter(t => t > 0 && t < 130);
    return temps.length ? Math.round(Math.max(...temps)) : null;
  } catch { return null; }
}

let diskCache = { at: 0, rows: [] };
function readDisks(cb) {
  if (Date.now() - diskCache.at < 10000) return cb(diskCache.rows);
  const done = rows => { diskCache = { at: Date.now(), rows }; cb(rows); };
  execFile('df', ['-h', '--output=size,used,avail,pcent,target', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'efivarfs', '-x', 'overlay'],
    (err, out) => {
      if (err) return done([]);
      done(out.trim().split('\n').slice(1).map(l => {
        const [size, used, avail, pcent, mount] = l.trim().split(/\s+/);
        return { size, used, avail, percent: parseInt(pcent), mount };
      }).filter(d => !d.mount.startsWith('/boot') && !d.mount.startsWith('/snap')));
    });
}

app.get('/api/stats', (_, res) => {
  const total = os.totalmem();
  let available = os.freemem();
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+) kB/);
    if (m) available = parseInt(m[1]) * 1024;
  } catch {}
  const used = total - available;
  readDisks(disks => res.json({
    cpu: { percent: cpuPercent(), cores: os.cpus().length, temp: readTemp() },
    memory: { total, used, percent: Math.round((used / total) * 100) },
    load: os.loadavg(),
    uptime: os.uptime(),
    disks,
  }));
});


// ── Port nuker ──
const run = (cmd, args, timeout = 4000) => new Promise(resolve => {
  execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseProcNet() {
  const map = new Map();
  for (const f of ['tcp', 'tcp6', 'udp', 'udp6']) {
    let txt;
    try { txt = fs.readFileSync('/proc/net/' + f, 'utf8'); } catch { continue; }
    for (const line of txt.trim().split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      const port = parseInt((c[1] || '').split(':')[1], 16);
      const state = c[3], inode = c[9];
      if (!port || !inode || inode === '0') continue;
      const listen = f.startsWith('udp') || state === '0A';
      if (!map.has(port)) map.set(port, []);
      map.get(port).push({ proto: f, inode, listen });
    }
  }
  return map;
}

function pidsForInodes(inodes) {
  const found = new Map();
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)); } catch {}
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const m = link.match(/^socket:\[(\d+)\]$/);
      if (m && inodes.has(m[1])) {
        if (!found.has(m[1])) found.set(m[1], new Set());
        found.get(m[1]).add(parseInt(pid));
      }
    }
  }
  return found;
}

function procInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rp = stat.lastIndexOf(')');
    const rest = stat.slice(rp + 2).split(' ');
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch {}
    return {
      pid, name: stat.slice(stat.indexOf('(') + 1, rp), state: rest[0], ppid: parseInt(rest[1]),
      cmd: cmd.slice(0, 140), uid: fs.statSync(`/proc/${pid}`).uid,
    };
  } catch { return null; }
}
const alive = pid => { const i = procInfo(pid); return !!i && i.state !== 'Z'; };

function protectedPids() {
  const set = new Set([1]);
  let pid = process.pid;
  for (let i = 0; i < 40 && pid > 1; i++) {
    set.add(pid);
    const info = procInfo(pid);
    if (!info) break;
    pid = info.ppid;
  }
  return set;
}

const SUPERVISOR = /^(npm|npx|yarn|pnpm|nodemon|bun|concurrently|ts-node-dev|tsx watch)\b/;
const isShellWrapper = i => /^(\/\S*\/)?(ba|da)?sh -c /.test(i.cmd);

function supervisorsOf(pid, guard) {
  const chain = [], pending = [];
  let cur = procInfo(pid);
  for (let i = 0; i < 8 && cur && cur.ppid > 1; i++) {
    const parent = procInfo(cur.ppid);
    if (!parent || guard.has(parent.pid)) break;
    if (SUPERVISOR.test(parent.name) || SUPERVISOR.test(parent.cmd)) { chain.push(...pending, parent.pid); pending.length = 0; }
    else if (isShellWrapper(parent)) pending.push(parent.pid);
    else break;
    cur = parent;
  }
  return chain;
}

async function ownersOf(port) {
  const entries = parseProcNet().get(port) || [];
  const owners = new Set();
  if (entries.length) {
    for (const set of pidsForInodes(new Set(entries.map(e => e.inode))).values()) set.forEach(p => owners.add(p));
  }
  const ss = await run('ss', ['-H', '-tulnp', `sport = :${port}`]);
  for (const m of ss.out.matchAll(/pid=(\d+)/g)) owners.add(parseInt(m[1]));
  return { entries, owners: [...owners].filter(alive) };
}

const portInUse = port => (parseProcNet().get(port) || []).some(e => e.listen);

async function nukePort(port) {
  const result = { port, freed: false, killed: [], failed: [], notes: [] };
  const guard = protectedPids();
  const before = await ownersOf(port);

  if (!before.entries.length && !before.owners.length) {
    result.freed = true;
    result.notes.push('nothing was using this port');
    return result;
  }

  const dock = await run('docker', ['ps', '-q', '--filter', `publish=${port}`]);
  for (const id of dock.out.split('\n').filter(Boolean)) {
    const k = await run('docker', ['kill', id], 8000);
    result.notes.push(k.ok ? `killed docker container ${id}` : `docker kill ${id} failed`);
  }

  const targets = new Map();
  for (const pid of before.owners) {
    if (guard.has(pid)) { result.failed.push({ pid, name: procInfo(pid)?.name, reason: 'this is the dashboard itself' }); continue; }
    for (const sup of supervisorsOf(pid, guard)) if (!targets.has(sup)) targets.set(sup, 'supervisor');
    targets.set(pid, 'owner');
  }
  const order = [...targets.keys()].sort((a, b) => (targets.get(a) === 'supervisor' ? -1 : 0) - (targets.get(b) === 'supervisor' ? -1 : 0));
  const infos = new Map(order.map(p => [p, procInfo(p)]));
  const denied = new Set();

  const signal = async (pid, sig) => {
    try { process.kill(pid, sig); return true; }
    catch (e) {
      if (e.code === 'ESRCH') return true;
      denied.add(pid);
      const s = await run('sudo', ['-n', 'kill', '-' + sig.replace('SIG', ''), String(pid)]);
      return s.ok;
    }
  };

  for (const pid of order) await signal(pid, 'SIGTERM');
  await sleep(700);
  for (const pid of order) if (alive(pid)) await signal(pid, 'SIGKILL');
  await sleep(300);

  for (const pid of order) {
    const info = infos.get(pid);
    const item = { pid, name: info ? info.name : '?', cmd: info ? info.cmd : '' };
    if (alive(pid)) result.failed.push({ ...item, reason: denied.has(pid) ? 'permission denied (owned by another user; sudo needs a password)' : 'would not die' });
    else result.killed.push(item);
  }

  for (let i = 0; i < 8 && portInUse(port); i++) await sleep(250);

  if (portInUse(port)) {
    for (const proto of ['tcp', 'udp']) await run('sudo', ['-n', 'fuser', '-k', '-KILL', '-n', proto, String(port)]);
    await sleep(400);
  }

  result.freed = !portInUse(port);
  if (!result.freed) {
    const after = await ownersOf(port);
    if (!after.owners.length) result.notes.push('a process your user cannot see (root or another user) still holds it');
    result.notes.push(`try in a terminal: sudo fuser -k ${port}/tcp`);
  } else if (!result.killed.length && !result.notes.length) {
    result.notes.push('socket closed on its own');
  }
  return result;
}

const validPort = n => Number.isInteger(n) && n >= 1 && n <= 65535;

const portStatusCache = new Map();
app.get('/api/ports/status', async (req, res) => {
  const ports = String(req.query.ports || '').split(',').map(Number).filter(validPort).slice(0, 60);
  const key = ports.join(',');
  const hit = portStatusCache.get(key);
  if (hit && Date.now() - hit.at < 2000) return res.json(hit.data);
  const procNet = parseProcNet();
  const need = new Set();
  for (const p of ports) for (const e of procNet.get(p) || []) if (e.listen) need.add(e.inode);
  const byInode = need.size ? pidsForInodes(need) : new Map();
  const out = {};
  for (const p of ports) {
    const listening = (procNet.get(p) || []).filter(e => e.listen);
    const pids = new Set();
    listening.forEach(e => (byInode.get(e.inode) || []).forEach(pid => pids.add(pid)));
    out[p] = {
      listening: listening.length > 0,
      owners: [...pids].map(procInfo).filter(Boolean).map(i => ({ pid: i.pid, name: i.name })),
    };
  }
  portStatusCache.set(key, { at: Date.now(), data: out });
  if (portStatusCache.size > 8) portStatusCache.delete(portStatusCache.keys().next().value);
  res.json(out);
});

app.post('/api/ports/nuke', async (req, res) => {
  if (req.get('x-pomo') !== '1') return res.status(403).json({ error: 'forbidden' });
  const port = parseInt(req.body.port);
  if (!validPort(port)) return res.status(400).json({ error: 'Enter a port between 1 and 65535' });
  if (port === PORT) return res.status(400).json({ error: `${port} is this dashboard's own port` });
  if (port < 1024 && !req.body.force) return res.status(409).json({ needsConfirm: true });
  try { res.json(await nukePort(port)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});



// ── Git branches (read-only) ──
const REPOS = process.env.POMO_REPOS
  ? process.env.POMO_REPOS.split(':').filter(Boolean)
  : [path.join(os.homedir(), 'Rndai', 'labs-backend'), path.join(os.homedir(), 'Rndai', 'labs-frontend')];
const git = (cwd, args) => run('git', ['--no-optional-locks', '-C', cwd, ...args], 4000);

async function worktreesOf(repo) {
  const r = await git(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  return r.out.split('\n\n').map(block => {
    const o = {};
    for (const line of block.split('\n')) { const i = line.indexOf(' '); if (i > 0) o[line.slice(0, i)] = line.slice(i + 1); else if (line) o[line] = true; }
    return o;
  }).filter(o => o.worktree && !o.bare).map(o => o.worktree);
}

async function statusOf(dir) {
  const [st, lg] = await Promise.all([git(dir, ['status', '--porcelain=v2', '--branch']), git(dir, ['log', '-1', '--format=%h %s'])]);
  if (!st.ok) return null;
  let branch = null, oid = '', upstream = null, ahead = 0, behind = 0, dirty = 0;
  for (const l of st.out.split('\n')) {
    if (l.startsWith('# branch.head ')) branch = l.slice(14);
    else if (l.startsWith('# branch.oid ')) oid = l.slice(13, 20);
    else if (l.startsWith('# branch.upstream ')) upstream = l.slice(18);
    else if (l.startsWith('# branch.ab ')) { const m = l.match(/\+(\d+) -(\d+)/); if (m) { ahead = +m[1]; behind = +m[2]; } }
    else if (l && !l.startsWith('#')) dirty++;
  }
  if (branch === '(detached)') branch = 'detached @ ' + oid;
  return { branch, upstream, ahead, behind, dirty, last: lg.ok ? lg.out.trim() : '' };
}

let branchCache = { at: 0, data: [], pending: null };
async function loadBranches() {
  const perRepo = await Promise.all(REPOS.filter(r => fs.existsSync(r)).map(async repo => {
    const trees = await worktreesOf(repo);
    const dirs = (trees.length ? trees : [repo]).slice(0, 4);
    const rows = await Promise.all(dirs.map(async (dir, i) => {
      const st = await statusOf(dir);
      return st && { repo: path.basename(repo), dir, main: i === 0, ...st };
    }));
    return rows.filter(Boolean);
  }));
  return perRepo.flat();
}
app.get('/api/branches', async (_, res) => {
  if (Date.now() - branchCache.at < 10000) return res.json(branchCache.data);
  if (!branchCache.pending) {
    branchCache.pending = loadBranches().then(data => { branchCache = { at: Date.now(), data, pending: null }; return data; })
      .catch(() => { branchCache.pending = null; return branchCache.data; });
  }
  res.json(await branchCache.pending);
});


// ── Free-space cleanup: fixed allow-list of regenerable locations, nothing user-supplied ──
const HOME = os.homedir();
const TMP_DIR = process.env.POMO_TMP_DIR || '/tmp';
const entriesOf = dir => { try { return fs.readdirSync(dir).map(n => path.join(dir, n)); } catch { return []; } };

const CLEAN_OPS = [
  { id: 'trash', label: 'Trash', checked: true, desc: 'Files you already deleted. Emptying is permanent.',
    targets: async () => ['files', 'info', 'expunged'].flatMap(d => entriesOf(path.join(HOME, '.local/share/Trash', d))) },
  { id: 'test-browsers', label: 'Leftover test-browser folders', checked: true, desc: 'Puppeteer temp profiles in /tmp that no browser is using.',
    targets: async () => {
      const dirs = entriesOf(TMP_DIR).filter(p => /^puppeteer_dev_chrome_profile-[A-Za-z0-9]+$/.test(path.basename(p)));
      const idle = [];
      for (const d of dirs) if (!(await run('pgrep', ['-f', '--', `user-data-dir=${d}`])).ok) idle.push(d);
      return idle;
    } },
  { id: 'npm', label: 'npm download cache', checked: true, desc: 'Fetched again automatically on the next install.',
    targets: async () => [...entriesOf(path.join(HOME, '.npm/_cacache')), ...entriesOf(path.join(HOME, '.npm/_logs'))] },
  { id: 'pip', label: 'pip cache', checked: true, desc: 'Fetched again automatically on the next install.',
    targets: async () => entriesOf(path.join(HOME, '.cache/pip')) },
  { id: 'thumbs', label: 'Image thumbnails', checked: true, desc: 'Rebuilt as you browse folders.',
    targets: async () => entriesOf(path.join(HOME, '.cache/thumbnails')) },
  { id: 'chrome', label: 'Chrome cache', checked: false, desc: 'Temporary web files. Sites load a bit slower once.',
    targets: async () => entriesOf(path.join(HOME, '.cache/google-chrome')).flatMap(profile => ['Cache', 'Code Cache', 'GPUCache'].flatMap(sub => entriesOf(path.join(profile, sub)))) },
  { id: 'dev-downloads', label: 'Dev tool downloads', checked: false, desc: 'Electron, Prisma engines, TypeScript. Downloaded again when a project needs them.',
    targets: async () => ['electron', 'prisma', 'typescript'].flatMap(n => entriesOf(path.join(HOME, '.cache', n))) },
];

async function sizeOf(paths) {
  let kb = 0;
  for (let i = 0; i < paths.length; i += 200) {
    const r = await run('du', ['-sk', '--', ...paths.slice(i, i + 200)], 60000);
    for (const line of r.out.split('\n')) { const n = parseInt(line); if (n >= 0) kb += n; }
  }
  return kb * 1024;
}
async function freeBytes() {
  const r = await run('df', ['-k', '--output=avail', '/']);
  return (parseInt(r.out.split('\n')[1]) || 0) * 1024;
}

app.get('/api/cleanup/scan', async (_, res) => {
  const chromeRunning = (await run('pgrep', ['-x', 'chrome'])).ok;
  const ops = await Promise.all(CLEAN_OPS.map(async op => {
    const targets = await op.targets();
    const note = op.id === 'chrome' && chromeRunning ? ' Chrome is open, so some files may stay.' : '';
    return { id: op.id, label: op.label, desc: op.desc + note, checked: op.checked, items: targets.length, bytes: await sizeOf(targets) };
  }));
  const [apt, journal] = await Promise.all([sizeOf(['/var/cache/apt']), run('journalctl', ['--disk-usage'])]);
  const jm = journal.out.match(/take up ([\d.]+)([KMGT])/);
  const jbytes = jm ? parseFloat(jm[1]) * { K: 1024, M: 1048576, G: 1073741824, T: 1099511627776 }[jm[2]] : 0;
  res.json({
    ops, free: await freeBytes(),
    needsSudo: [
      { label: 'apt package cache', bytes: apt, cmd: 'sudo apt clean' },
      { label: 'old system logs', bytes: jbytes, cmd: 'sudo journalctl --vacuum-size=50M' },
    ],
  });
});

let cleaning = false;
app.post('/api/cleanup/run', async (req, res) => {
  if (req.get('x-pomo') !== '1') return res.status(403).json({ error: 'forbidden' });
  if (cleaning) return res.status(409).json({ error: 'a cleanup is already running' });
  cleaning = true;
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const before = await freeBytes();
    const results = [];
    for (const op of CLEAN_OPS.filter(o => ids.includes(o.id))) {
      const targets = await op.targets();
      const bytes = await sizeOf(targets);
      let removed = 0, failed = 0;
      for (const t of targets) {
        try { fs.rmSync(t, { recursive: true, force: true }); removed++; } catch { failed++; }
      }
      results.push({ id: op.id, label: op.label, bytes, removed, failed });
    }
    const free = await freeBytes();
    res.json({ results, free, freed: Math.max(0, free - before) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    cleaning = false;
  }
});

app.listen(PORT, '127.0.0.1', () => console.log(`Starchy Times running at http://localhost:${PORT}`));
