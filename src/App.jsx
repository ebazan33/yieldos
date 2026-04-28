// Top-level route gate. Before mounting the full app, check the hash —
// if it's #privacy or #terms, we short-circuit and render the static
// legal page instead. This keeps AppMain's giant hook list intact
// (no Rules of Hooks violations from an early return splitting hooks).
//
// Also listens for Supabase's PASSWORD_RECOVERY event (fired when the user
// lands via a reset-password email link) and pops the ResetPasswordModal
// over whatever's currently rendered, so they can actually set a new pw.
import { useEffect, useState } from "react";
import AppMain from "./AppMain.jsx";
import { PrivacyPage, TermsPage } from "./components/LegalPage.jsx";
import ResetPasswordModal from "./components/ResetPasswordModal.jsx";
import SharedPortfolioView from "./components/SharedPortfolioView.jsx";
import SimulatorPage from "./pages/SimulatorPage.jsx";
import { supabase } from "./lib/supabase";

function readHash() {
  if (typeof window === "undefined") return "";
  return (window.location.hash || "").replace(/^#/, "").toLowerCase();
}

// Path-based share route. Anything under /share/<slug> short-circuits the
// logged-in app and mounts the public SharedPortfolioView. We only accept
// the exact shape /share/<slug> (single path segment) so downstream
// path additions don't accidentally match.
function readSharedSlug() {
  if (typeof window === "undefined") return null;
  const m = window.location.pathname.match(/^\/share\/([A-Za-z0-9_-]+)\/?$/);
  return m ? m[1] : null;
}

// Path-based simulator route. Anything at /simulator (with or without a
// trailing slash, plus optional query string) short-circuits the logged-in
// app and mounts the public SimulatorPage. Free, no-login backtest tool —
// designed to be the viral acquisition surface for Moat #4.
function readIsSimulator() {
  if (typeof window === "undefined") return false;
  return /^\/simulator\/?$/.test(window.location.pathname);
}

export default function App() {
  const [route, setRoute] = useState(readHash);
  const [sharedSlug] = useState(readSharedSlug);
  const [isSimulator] = useState(readIsSimulator);
  const [showReset, setShowReset] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Supabase auth events:
  //   PASSWORD_RECOVERY → fires when the user lands via a reset-password
  //     email link. We pop ResetPasswordModal over whatever's rendered.
  //   SIGNED_IN → fires on every fresh sign-in (and on session restore on
  //     page load). We use this to defensively set the 14-day Grow trial
  //     on users who never got one — specifically Google OAuth signups,
  //     which bypass AuthModal's signUp() options.data path and land in
  //     auth.users without trial_ends_at metadata. The handler is
  //     idempotent: if the user already has trial_ends_at, we no-op.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setShowReset(true);

      if (event === "SIGNED_IN" && session?.user) {
        const meta = session.user.user_metadata || {};
        if (!meta.trial_ends_at) {
          // Fire-and-forget. If updateUser fails, AppMain handles missing
          // trial metadata gracefully (treats user as Seed with no trial).
          (async () => {
            try {
              const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
              await supabase.auth.updateUser({
                data: {
                  plan: meta.plan || "Seed",
                  trial_ends_at: trialEndsAt,
                },
              });
            } catch {
              // Silent — defensive logic shouldn't block sign-in.
            }
          })();
        }
      }
    });
    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  const goHome = () => {
    // Clear the hash without adding a new history entry.
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    setRoute("");
  };

  let main;
  // Public share viewer runs standalone — no AppMain auth flow, no hash legal
  // pages. If the URL matches /share/<slug>, that's the whole page.
  if (sharedSlug)               main = <SharedPortfolioView slug={sharedSlug} />;
  else if (isSimulator)         main = <SimulatorPage />;
  else if (route === "privacy") main = <PrivacyPage onBack={goHome} />;
  else if (route === "terms")   main = <TermsPage   onBack={goHome} />;
  else                          main = <AppMain />;

  return (
    <>
      {main}
      {showReset && <ResetPasswordModal onDone={() => setShowReset(false)} />}
    </>
  );
}
