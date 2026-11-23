import { mkdir, writeFile, readFile, copyFile, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tiny generated files and one streamed 32 MiB file exercise transport/preview
// boundaries. Their values have no scientific meaning.
export async function generateParityFiles(workspace) {
  const here = dirname(fileURLToPath(import.meta.url));
  const results = join(workspace, 'results');
  await mkdir(results, { recursive: true, mode: 0o700 });
  const files = [];
  async function write(name, contents) {
    await writeFile(join(results, name), contents, { flag: 'wx', mode: 0o600 });
    files.push(`results/${name}`);
  }
  for (const name of ['structure.cif', 'trajectory.extxyz', 'density.cube', 'DOSCAR', 'report.pdf']) {
    await copyFile(join(here, 'visualization-fixtures', name), join(results, name));
    files.push(`results/${name}`);
  }
  await copyFile(join(here, 'parity-fixtures', 'preview.avif'), join(results, 'preview.avif'));
  files.push('results/preview.avif');
  const cube = await readFile(join(here, 'visualization-fixtures', 'density.cube'), 'utf8');
  await write('large-density.cube', 'Engineering size fixture ' + 'x'.repeat(16 * 1024 * 1024) + '\n' + cube.split('\n').slice(1).join('\n'));
  await write('long-field.csv', 'label,value\n"' + 'x'.repeat(600000) + '",42\n');
  await write('oversize.csv', 'label,value\n"' + 'x'.repeat(1024 * 1024) + '",42\n');
  await write('oversize.txt', 'Engineering fixture\n' + 'x'.repeat(512 * 1024));
  await write('oversize.html', '<!doctype html><p>Engineering fixture</p><!--' + 'x'.repeat(512 * 1024) + '-->');
  await write('oversize.svg', '<svg xmlns="http://www.w3.org/2000/svg"><!--' + 'x'.repeat(2 * 1024 * 1024) + '--></svg>');
  await write('table-limits.csv', Array.from({ length: 150 }, (_, row) => Array.from({ length: 60 }, (_, col) => `${row}:${col}`).join(',')).join('\n'));
  await write('preview.htm', '<!doctype html><h1>HTML 工程预览</h1><p>无脚本示例</p>');
  await write('notes.markdown', '# 工程验收\n\n这不是实际科研结果。\n');
  const large = await open(join(results, 'large-32MiB.bin'), 'wx', 0o600);
  try {
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    for (let index = 0; index < 512; index++) await large.write(chunk);
  } finally { await large.close(); }
  files.push('results/large-32MiB.bin');
  return files;
}
