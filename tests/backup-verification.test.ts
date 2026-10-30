import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
const parser = `import sys,json\nfrom scripts.backup_verification import parse_backup_output\ncounts,history=parse_backup_output(sys.stdin.read())\nprint(json.dumps({'counts':counts,'history':history}))`;
function parse(text: string) {
  return spawnSync('python3', ['-c', parser], { input: text, encoding: 'utf8', env: { PATH: process.env.PATH!, PYTHONDONTWRITEBYTECODE: '1' } });
}
const history = [{ migration_name: '20261011000000_init', checksum: 'a'.repeat(64), completed: true, rolled_back: false },
  { migration_name: '20261011010000_m21_ingestion', checksum: 'b'.repeat(64), completed: true, rolled_back: false }];
it('parses complete multiline psql JSON documents without treating newlines as records', () => {
  const result = parse(` \n {"SecurityEvent":548,"AiAnalysis":202}\n${JSON.stringify(history, null, 2)}\n\n`);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ counts: { SecurityEvent: 548, AiAnalysis: 202 }, history });
});
it.each(['{"SecurityEvent":1}\n[', '{"SecurityEvent":1}\n[]', '{"SecurityEvent":true}\n'+JSON.stringify(history),
  '{"SecurityEvent":1,"SecurityEvent":2}\n'+JSON.stringify(history), '{"SecurityEvent":1}\n'+JSON.stringify(history)+'\nNOTICE: ignored?',
  '{"SecurityEvent":1}\n'+JSON.stringify(history)+'\n{}'])('rejects malformed or unexpected verification output without suppressing errors', (text) => {
  const result = parse(text); expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
});
