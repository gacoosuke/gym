import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'fr.souvenirsphysiques.album',
  appName: 'Souvenirs physiques',
  webDir: 'dist/public',
  server: {
    androidScheme: 'https',
  },
  android: {
    backgroundColor: '#191c25',
  },
};

export default config;