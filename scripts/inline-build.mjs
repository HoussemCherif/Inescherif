/**
 * Produit une version monofichier de la page à partir de dist/ :
 *   dist-single/index.html  — document autonome (s'ouvre directement, sans serveur)
 *   dist-single/fragment.html — même contenu sans <html>/<head>/<body>, pour l'intégrer dans une page hôte
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(root, 'dist-single');
let html = readFileSync(join(dist, 'index.html'), 'utf8');

const read = (href) => readFileSync(join(dist, href.replace(/^\.?\//, '')), 'utf8');
const scripts = [];

// Feuilles de style locales → <style>
html = html.replace(/<link rel="stylesheet"[^>]*href="(\.?\/?assets\/[^"]+\.css)"[^>]*>/g, (_, href) => `<style>\n${read(href)}\n</style>`);

// Scripts modules locaux → retirés de <head>, réinjectés en ligne en fin de <body>
html = html.replace(/<script type="module"[^>]*src="(\.?\/?assets\/[^"]+\.js)"[^>]*><\/script>/g, (_, src) => {
  scripts.push(read(src).replace(/<\/script/gi, '<\\/script'));
  return '';
});
html = html.replace(/<link rel="modulepreload"[^>]*>/g, '');
html = html.replace('</body>', `${scripts.map((code) => `<script type="module">\n${code}\n</script>`).join('\n')}\n</body>`);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), html);

const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
const headKeep = head
  .replace(/<meta charset[^>]*>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '<meta name="claude:viewport-fit-sides" content="cover" />\n    ');
writeFileSync(join(out, 'fragment.html'), `${headKeep.trim()}\n${body.trim()}\n`);

const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} Ko`;
console.log(`dist-single/index.html    ${kb(html)}`);
console.log(`dist-single/fragment.html ${kb(readFileSync(join(out, 'fragment.html'), 'utf8'))}`);
