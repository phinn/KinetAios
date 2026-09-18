// privacy-gate 单元验证脚本(临时,不进仓库)—— 直接测正则与高熵逻辑。
const SECRET_PATTERNS = [
  /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /GLM_[A-Za-z0-9]{20,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./,
  /\b[aA]uthorization["']?\s*[:=]\s*["']?[bB]earer\s+[A-Za-z0-9._-]{20,}/,
];
function shannonEntropy(s) {
  if (!s) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}
function highEntropyTokens(text) {
  const out = []; const re = /[A-Za-z0-9_-]{20,}/g; const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = m[0];
    if (!seen.has(t)) { seen.add(t); if (shannonEntropy(t) >= 4.2) out.push(t); }
  }
  return out.slice(0, 5);
}
const SENSITIVE_PATH_RE = /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|id_ecdsa|\.npmrc|\.netrc|credentials(\.json)?|secrets?\.(ya?ml|json|txt))$/i;
function scan(text, sourcePath) {
  const reasons = [];
  if (sourcePath && SENSITIVE_PATH_RE.test(sourcePath.trim())) reasons.push('sensitive file');
  for (const re of SECRET_PATTERNS) { const m = text.match(re); if (m) { reasons.push('secret: ' + m[0].slice(0, 12)); break; } }
  if (reasons.length === 0) { const t = highEntropyTokens(text); if (t.length) reasons.push('entropy: ' + t[0].slice(0, 16)); }
  return reasons;
}
let pass = 0, fail = 0;
function expect(name, got, want) {
  const ok = want === 'HIT' ? got.length > 0 : got.length === 0;
  if (ok) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, '→', JSON.stringify(got)); }
}
console.log('高置信命中:');
expect('normal code', scan('const x = 42; function foo() { return x + 1; }', undefined), 'PASS');
expect('openai sk- key', scan('OPENAI_API_KEY=sk-proj4bcD3fGhIjKlMnOpQrStUvWx', undefined), 'HIT');
expect('aws key', scan('aws_access_key_id = AKIAIOSFODNN7EXAMPLE', undefined), 'HIT');
expect('rsa private key', scan('-----BEGIN RSA PRIVATE KEY-----', undefined), 'HIT');
expect('openssh key', scan('-----BEGIN OPENSSH PRIVATE KEY-----', undefined), 'HIT');
expect('jwt', scan('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig', undefined), 'HIT');
expect('github token', scan('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789', undefined), 'HIT');
expect('glm key', scan('api_key = GLM_abc123def456ghi789jkl0', undefined), 'HIT');
expect('bearer header', scan("Authorization: Bearer abcdef1234567890abcdef123456", undefined), 'HIT');
expect('slack token', scan('xoxb-123456789012-abcdefghijkl', undefined), 'HIT');
console.log('高熵兜底:');
expect('random secret', scan('secret = "vN8qX2mP7kR4jT9wL3bY6hF1"', undefined), 'HIT');
expect('long english sentence', scan('the quick brown fox jumps over the lazy dog again and again', undefined), 'PASS');
expect('normal long identifier', scan('const calculateTotalPriceWithTaxAndDiscount = 1', undefined), 'PASS');
console.log('敏感路径:');
expect('.env', scan('DEBUG=1', '/home/u/proj/.env'), 'HIT');
expect('id_rsa', scan('内容', '/Users/u/.ssh/id_rsa'), 'HIT');
expect('.npmrc', scan('//registry=', '/home/u/.npmrc'), 'HIT');
expect('normal ts file', scan('export {}', '/proj/src/main/tools.ts'), 'PASS');
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
