/**
 * openfront v2 runs private matches only: the master schedules no public
 * lobbies (nor creates them for a lobby coordinator), and hosts cannot list
 * their private lobby in the public lobby browser. Set PUBLIC_MATCHES=1 in
 * the server's environment to bring the public queue back.
 */
export function publicMatchesEnabled(): boolean {
  return process.env.PUBLIC_MATCHES === "1";
}
