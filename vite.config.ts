import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // GitHub Pages 등 하위 경로 배포 시 BASE_PATH=/repo-name/ 으로 빌드
  base: process.env.BASE_PATH ?? '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: '메이플 할일 알리미',
        short_name: '메이플알리미',
        description: '메이플스토리 스케줄러 기반 보스/일일/주간 할일 현황',
        lang: 'ko',
        theme_color: '#f28c28',
        background_color: '#16181d',
        display: 'standalone',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // API 응답은 캐시하지 않음 (항상 최신 스케줄러 상태가 필요)
        navigateFallbackDenylist: [/^\/maplestory\//],
      },
    }),
  ],
});
