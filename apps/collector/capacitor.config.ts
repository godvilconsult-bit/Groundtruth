import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wrapper for the collector (DECISIONS D-017).
 *
 * The web build is the app; this only supplies the native shell and, later, the
 * background-geolocation plugin that a browser cannot provide.
 */
const config: CapacitorConfig = {
  appId: 'tz.groundtruth.collector',
  appName: 'Ground Truth',
  webDir: 'dist',

  android: {
    // Debug builds only for now. A release build needs a signing key, which is a
    // credential decision for whoever runs the business, not one to generate here.
    buildOptions: {},
    // Cleartext stays OFF. Field data crosses a mobile network; an accidental
    // http:// endpoint would put observations and consent references in the clear.
    allowMixedContent: false,
  },

  server: {
    androidScheme: 'https',
  },
};

export default config;
