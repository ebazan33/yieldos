// Top-level route gate. Before mounting the full app, check the hash —
// if it's #privacy or #terms, we short-circuit and render the static
// legal page instead. This keeps AppMain's giant hook list intact
// (no Rules of Hooks violations from an early return splitting hooks).
import { useEffect, useState } from "react";
import AppMain from "./AppMain.jsx";
import { PrivacyPage, TermsPage } from "./components/LegalPage.jsx";

function readHash() {
  if (typeof window === "undefined") return "";
  return (window.location.hash || "").replace(/^#/, "").toLowerCase();
}

export default function App() {
  const [route, setRoute] = useState(readHash);

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const goHome = () => {
    // Clear the hash without adding a new history entry.
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    setRoute("");
  };

  if (route === "privacy") return <PrivacyPage onBack={goHome} />;
  if (route === "terms")   return <TermsPage   onBack={goHome} />;
  return <AppMain />;
}
