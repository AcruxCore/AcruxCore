// Placeholder for local dev and plain `vite build` output. The web container
// overwrites this file at start-up from SENTRY_WEB_DSN and GA4_MEASUREMENT_ID
// (see docker/40-runtime-config.sh). Empty values mean both features are off.
window.__ACRUXCORE_CONFIG__ = { sentryWebDsn: '', ga4MeasurementId: '' };
