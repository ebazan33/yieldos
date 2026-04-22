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

export default function App() {
  const [route, setRoute] = useState(readHash);
  const [sharedSlug] = useState(readSharedSlug);
  const [showReset, setShowReset] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Supabase fires PASSWORD_RECOVERY when it detects the #access_token=...&type=recovery
  // hash from a reset-password email. We show the "set new password" modal
  // on top of whatever's currently rendered (landing, app, legal page).
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setShowReset(true);
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
