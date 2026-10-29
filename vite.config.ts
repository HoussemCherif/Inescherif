import { defineConfig } from 'vite';

export default defineConfig({
  // Chemins relatifs : le dossier dist/ fonctionne à la racine d'un domaine comme dans un sous-dossier.
  base: './',
  // allowedHosts : accepte les tunnels rapides Cloudflare (cloudflared tunnel --url …).
  server: { host: true, port: 5173, allowedHosts: ['.trycloudflare.com'] },
  preview: { host: true, port: 4173, allowedHosts: ['.trycloudflare.com'] },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
});
