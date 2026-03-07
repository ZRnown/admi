export type MinimalDiscordRule = {
  discordSenderAccountId?: string;
};

export type MinimalDiscordInstance = {
  discordAccountId?: string;
  discordSenderAccountId?: string;
  mappings?: MinimalDiscordRule[];
  telegramConfig?: {
    mappings?: MinimalDiscordRule[];
  };
};

export function clearDiscordLibraryReferences(
  instances: MinimalDiscordInstance[],
  validDiscordAccountIds: string[],
): boolean {
  const validIds = new Set(validDiscordAccountIds.filter(Boolean));
  let changed = false;

  const clearRuleRefs = (rules?: MinimalDiscordRule[]) => {
    for (const rule of rules || []) {
      if (rule?.discordSenderAccountId && !validIds.has(rule.discordSenderAccountId)) {
        delete rule.discordSenderAccountId;
        changed = true;
      }
    }
  };

  for (const instance of instances || []) {
    if (instance.discordAccountId && !validIds.has(instance.discordAccountId)) {
      delete instance.discordAccountId;
      changed = true;
    }
    if (instance.discordSenderAccountId && !validIds.has(instance.discordSenderAccountId)) {
      delete instance.discordSenderAccountId;
      changed = true;
    }
    clearRuleRefs(instance.mappings);
    clearRuleRefs(instance.telegramConfig?.mappings);
  }

  return changed;
}
