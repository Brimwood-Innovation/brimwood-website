/**
 * Canonical profile URL — the single rule every agent and page must use.
 *
 *   profileUrl({ id, username }) → "/@username" when a username is claimed,
 *                                  "/u/<id>" as the stable alias otherwise.
 *
 * /@username is canonical (the profile editor promises it as "your shareable
 * page"); /u/<id> never breaks when a username changes or is unclaimed, and
 * redirects client-side to the canonical URL when a username is known.
 */
export interface ProfileRef {
  id: string;
  username?: string | null;
}

export function profileUrl(user: ProfileRef | null | undefined): string {
  if (!user) return "/members";
  if (user.username) return `/@${user.username}`;
  if (user.id) return `/u/${user.id}`;
  return "/members";
}
