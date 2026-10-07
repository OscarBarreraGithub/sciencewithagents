// Consume before navigation/history hooks mount. No secret is placed in query/path,
// browser storage or a host URL; only an authenticated JSON request ingests it.
let invitation: string | null = null;
if (location.hash.startsWith('#/groups?invite=')) {
  invitation = location.href;
  history.replaceState(null, '', `${location.pathname}${location.search}#/groups`);
}
export const initialGroupInvitation = () => invitation;
export const clearGroupInvitation = () => {
  invitation = null;
};
