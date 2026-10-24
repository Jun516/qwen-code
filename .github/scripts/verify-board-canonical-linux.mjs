import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const expectedHead = '6c3f3208abbc69ff824ef9a03961aa2f6b695444';
const verifierFiles = new Set([
  '.github/workflows/verify-board-canonical-linux.yml',
  '.github/scripts/verify-board-canonical-linux.mjs',
]);
const root = path.resolve(process.argv[2] ?? process.cwd());
const outputBase = path.resolve(process.argv[3] ?? os.tmpdir());
assert.equal(process.platform, 'linux', 'This verifier requires Linux.');
assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Node 22+ required.');
await fs.mkdir(outputBase, { recursive: true });
const artifacts = await fs.mkdtemp(path.join(outputBase, 'board-linux-'));
const home = path.join(artifacts, 'home');
const workspace = path.join(artifacts, 'workspace');
await fs.mkdir(home);
await fs.mkdir(workspace);
const report = {
  result: 'FAILED',
  expectedProductHead: expectedHead,
  platform: process.platform,
  release: os.release(),
  node: process.version,
  artifacts,
  runs: [],
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function requireMissing(target) {
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
}

try {
  report.checkoutHead = git('rev-parse', 'HEAD');
  if (report.checkoutHead !== expectedHead) {
    assert.equal(git('rev-parse', 'HEAD^'), expectedHead);
    report.verifierChanges = git('diff', '--name-only', expectedHead, 'HEAD')
      .split('\n').filter(Boolean);
    assert.ok(report.verifierChanges.length > 0);
    assert.ok(report.verifierChanges.every((file) => verifierFiles.has(file)),
      'The child commit must change only the two allowlisted verifier files.');
  }
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '',
    'Tracked files must match the checked commit.');
  const cli = path.join(root, 'dist/cli.js');
  report.bundleSha256 = sha256(await fs.readFile(cli));
  report.verifierSha256 = sha256(await fs.readFile(new URL(import.meta.url)));

  const probe = path.join(home, 'case-probe');
  await fs.mkdir(probe);
  await fs.mkdir(path.join(probe, 'CaseProbe'));
  await requireMissing(path.join(probe, 'caseprobe'));
  await fs.mkdir(path.join(probe, 'caseprobe'));
  const entries = (await fs.readdir(probe)).sort();
  assert.deepEqual(entries, ['CaseProbe', 'caseprobe']);
  const upper = await fs.stat(path.join(probe, 'CaseProbe'));
  const lower = await fs.stat(path.join(probe, 'caseprobe'));
  assert.notEqual(upper.ino, lower.ino);
  report.caseSensitivity = {
    wrongCaseInitiallyENOENT: true,
    entries,
    distinctInodes: true,
    filesystemType: (await fs.statfs(home)).type,
  };

  const env = {
    PATH: process.env.PATH,
    HOME: home,
    QWEN_HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    TMPDIR: artifacts,
    CI: 'true',
    NO_COLOR: '1',
    LANG: 'C.UTF-8',
  };
  function run(args, expectedExit = 0) {
    const result = spawnSync(process.execPath, [cli, 'board', ...args], {
      cwd: workspace, env, encoding: 'utf8', timeout: 30_000,
    });
    report.runs.push({ args: ['board', ...args], exit: result.status,
      stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, expectedExit, result.stderr);
    if (expectedExit === 0) {
      assert.equal(result.stderr, '');
      return JSON.parse(result.stdout);
    }
    assert.equal(result.stdout, '');
    return result.stderr;
  }
  const task = run(['task', 'linux-case-control', '--board', 'MixedCaseBoard',
    '--as', 'MiXeDActor', '--owner', 'OwNeR', '--json']);
  const ask = run(['ask', 'ReCeIvEr', 'linux-case-control', '--board',
    'MIXEDCASEBOARD', '--as', 'MiXeDActor', '--json']);
  assert.match(task.id, /^t-[0-9a-f-]+$/);
  assert.match(ask.id, /^a-[0-9a-f-]+$/);
  assert.equal(task.createdBy, 'MiXeDActor');
  assert.equal(task.owner, 'OwNeR');
  assert.equal(ask.from, 'MiXeDActor');
  assert.equal(ask.to, 'ReCeIvEr');
  const boardsRoot = path.join(home, 'boards');
  const directories = (await fs.readdir(boardsRoot)).sort();
  assert.deepEqual(directories, ['mixedcaseboard']);
  await requireMissing(path.join(boardsRoot, 'MixedCaseBoard'));
  await requireMissing(path.join(boardsRoot, 'MIXEDCASEBOARD'));
  for (const spelling of ['MixedCaseBoard', 'MIXEDCASEBOARD', 'mixedcaseboard']) {
    const snapshot = run(['show', '--board', spelling, '--json']);
    assert.equal(snapshot.board, directories[0]);
    assert.deepEqual(snapshot.tasks, [task]);
    assert.deepEqual(snapshot.asks, [ask]);
    const directory = path.join(boardsRoot, snapshot.board);
    assert.deepEqual((await fs.readdir(path.join(directory, 'tasks'))).sort(),
      [`${task.id}.json`]);
    assert.deepEqual((await fs.readdir(path.join(directory, 'asks'))).sort(),
      [`${ask.id}.json`]);
    for (const [collection, record] of [['tasks', task], ['asks', ask]]) {
      const file = path.join(directory, collection, `${record.id}.json`);
      assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), record);
    }
  }
  assert.deepEqual(run(['show', '--board', 'EmptyMixed', '--json']),
    { board: 'emptymixed', tasks: [], asks: [] });
  for (const [actor, tasks, asks] of [
    ['OwNeR', [task], []], ['owner', [], []],
    ['ReCeIvEr', [], [ask]], ['receiver', [], []],
  ]) {
    assert.deepEqual(run(['show', '--board', 'MIXEDCASEBOARD', '--as', actor,
      '--json']), { board: 'mixedcaseboard', tasks, asks });
  }
  for (const invalid of ['Bad/Name', 'CON', 'Bad.', 'A'.repeat(65)]) {
    assert.ok(run(['show', '--board', invalid, '--json'], 1)
      .includes(`Invalid board name "${invalid}".`));
  }
  assert.equal(run(['show', '--json'], 1), 'Pass --board <name>.\n');
  assert.ok(run(['show', '--board', 'MixedCaseBoard', '--as', 'Bad/Actor',
    '--json'], 1).includes('Invalid actor name "Bad/Actor".'));
  assert.deepEqual((await fs.readdir(boardsRoot)).sort(), directories);
  report.storage = { directories, taskId: task.id, askId: ask.id,
    noncanonicalDirectoryENOENT: true, jsonConstructedPathsReadSuccessfully: true };
  report.successfulCommands = report.runs.filter((run) => run.exit === 0).length;
  report.expectedRejections = report.runs.filter((run) => run.exit === 1).length;
  report.result = 'PASSED';
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  const output = path.resolve(process.env.BOARD_LINUX_REPORT ??
    path.join(root, '.qwen/verification/board-linux-result.json'));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ result: report.result, output }));
}
