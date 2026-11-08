import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const workflow = readFileSync(new URL('../.github/workflows/pwa-web.yml', import.meta.url), 'utf8')
const step = workflow.split('      - name: Build velta.cc/web variant\n')[1].split('\n      - name:')[0]
const script = step.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n')

test('web publish uses repo variable through env and refuses missing built keys', () => {
  assert.match(step, /PWA_ONBOARDING_KEYS: \$\{\{ vars\.PWA_ONBOARDING_KEYS \}\}/)
  assert.doesNotMatch(script, /\$\{\{/)
  const dir = mkdtempSync(join(tmpdir(), 'pwa-web-keys-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    // Stand in for the expensive wasm build; exercise the actual workflow shell.
    writeFileSync(join(dir, 'scripts/build-pwa.mjs'), `
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      const flag = name => process.argv[process.argv.indexOf(name) + 1];
      const keys = JSON.parse(readFileSync(flag('--onboarding-keys'), 'utf8'));
      const out = flag('--out');
      mkdirSync(out, { recursive: true });
      writeFileSync(out + '/pwa-config.js', 'window.VELTA_PWA = { wsProxyUrl: "", onboardingKeys: ' + JSON.stringify(keys) + ' }; if ("serviceWorker" in navigator) {}');
      writeFileSync(out + '/sw.js', "const VERSION = 'test';");
    `)
    const run = keys => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: join(dir, 'summary'), PWA_ONBOARDING_KEYS: keys },
    })
    let result = run('')
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /Set the PWA_ONBOARDING_KEYS repository variable/)
    result = run('{}')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must include the veltar1 onboarding public key/)
    result = run('{"veltar1":"public-key"}')
    assert.equal(result.status, 0, result.stdout + result.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
