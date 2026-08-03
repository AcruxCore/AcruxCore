/// <reference types="vite/client" />

// Auth needs no browser-side configuration: the Better Auth client talks to our
// own API at the page's origin, and the session is an httpOnly cookie. This file
// previously carried VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY — a vendor
// project ref and a publishable key that had to be baked into the bundle.
