"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAllowedByConfig = isAllowedByConfig;
exports.isNotInMutedIds = isNotInMutedIds;
exports.isInAllowedIds = isInAllowedIds;
function isAllowedByConfig(message, config) {
    const allowedUsers = [
        ...(config.allowedUsersIds ?? []),
        ...(config.channelConfigs?.[message.channel.id]?.allowed ?? [])
    ];
    const mutedUsers = [
        ...(config.mutedUsersIds ?? []),
        ...(config.channelConfigs?.[message.channel.id]?.muted ?? [])
    ];
    return (
    // Guild check
    isInAllowedIds(message.guildId, config.allowedGuildsIds) &&
        isNotInMutedIds(message.guildId, config.mutedGuildsIds) &&
        // Channel check
        isInAllowedIds(message.channelId, config.allowedChannelsIds) &&
        isNotInMutedIds(message.channelId, config.mutedChannelsIds) &&
        // Author check
        isInAllowedIds(message.author?.id, allowedUsers) &&
        isNotInMutedIds(message.author?.id, mutedUsers));
}
function isNotInMutedIds(id, mutedIds = []) {
    if (mutedIds.length === 0)
        return true;
    if (id == null)
        return true;
    return !(mutedIds.includes(id) || mutedIds.includes(Number(id)));
}
function isInAllowedIds(id, allowedIds = []) {
    if (allowedIds.length === 0)
        return true;
    if (id == null)
        return false;
    return allowedIds.includes(id) || allowedIds.includes(Number(id));
}
//# sourceMappingURL=filterMessages.js.map