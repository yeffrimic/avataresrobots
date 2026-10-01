// Genera un certificado autofirmado para servir por HTTPS en la red local (requiere openssl,
// que viene instalado en Linux, macOS y en Git para Windows).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4').map((i) => i.address);
const san = ['DNS:localhost', ...ips.map((ip) => `IP:${ip}`)].join(',');

fs.mkdirSync('certs', { recursive: true });
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
    '-keyout', 'certs/key.pem', '-out', 'certs/cert.pem',
    '-subj', '/CN=Avatar local', '-addext', `subjectAltName=${san}`,
  ], { stdio: 'inherit' });
  console.log('\n  Certificado creado en certs/. Reinicia con: npm start');
  console.log('  En el móvil verás un aviso de seguridad: toca «Avanzado» → «Continuar».\n');
} catch {
  console.error('\n  No encontré openssl. Instálalo (sudo apt install openssl) o usa un túnel HTTPS, ver README.\n');
  process.exit(1);
}
