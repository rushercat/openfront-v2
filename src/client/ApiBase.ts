import { ClientEnv } from "./ClientEnv";

// The account/shop API origin (api.<audience>). Lives apart from Api.ts so
// modules that Api.ts itself depends on (ServerList) can reach it without an
// import cycle; Api.ts re-exports both for its existing importers.

export function getApiBase() {
  const domainname = getAudience();

  if (domainname === "localhost") {
    const apiDomain = process.env.API_DOMAIN;
    if (apiDomain) {
      return `https://${apiDomain}`;
    }
    const override = localStorage.getItem("apiHost");
    if (override) return override;
    // openfront v2: a production build served with DOMAIN=localhost is a
    // self-hosted game (hosting/start-openfront.ps1) that players reach from
    // other machines, where localhost:8787 is their own computer. Ask the
    // page's own server instead; it answers every API path "not found"
    // (Master.ts, /_localapi), so the server list falls back to this server.
    if (process.env.GAME_ENV === "prod") {
      return `${window.location.origin}/_localapi`;
    }
    return "http://localhost:8787";
  }

  return `https://api.${domainname}`;
}

export function getAudience() {
  // Sourced from BOOTSTRAP_CONFIG (server/desktop-injected) rather than
  // window.location, so the desktop app (app://openfront) targets real infra.
  return ClientEnv.jwtAudience();
}
