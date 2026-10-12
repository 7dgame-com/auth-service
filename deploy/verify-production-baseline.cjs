const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'production-baseline.json'), 'utf8'));
for (const file of manifest.preservedFiles) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file.path))).digest('hex');
  if (hash !== file.sha256) throw new Error(`Preserved production baseline changed: ${file.path}`);
}
console.log(JSON.stringify({baseline: manifest.baseRevision, preservedFiles: manifest.preservedFiles.length, valid: true}));
