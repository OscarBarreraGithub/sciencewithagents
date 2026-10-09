/** Shared native Git publication boundary. Activity adds its own stricter metadata filters. */
export const groupNativePrivatePath = (name: string) =>
  /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|id_rsa|id_ed25519|data|uploads|logs|\.codex|\.claude)(?:$|\/)/i.test(
    name,
  ) || /\.(?:pem|p12|pfx|key|sqlite|sqlite3|db|log)$/i.test(name);
