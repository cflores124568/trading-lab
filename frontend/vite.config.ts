import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite' 

export default defineConfig({
  plugins: [
    solid(),
    tailwindcss(), 
  ],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000', //python fastapi addy
        changeOrigin: true,
        secure: false,
      },
    },
  },
})